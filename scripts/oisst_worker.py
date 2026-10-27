"""Worker Python: baixa OISST v2.1 (anomalia diaria) via OPeNDAP/THREDDS PSL,
reduz resolucao e publica um GeoJSON leve em data/oisst-anomaly.json.

Roda no GitHub Actions (agendado). Nao roda na Vercel.
"""
import datetime
import json
import os
import sys

import numpy as np
import xarray as xr

OUT_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "oisst-anomaly.json")
COARSEN = 8  # 0.25 -> 2 graus
LAT_RANGE = (-30.0, 30.0)
LON_RANGE_E = (120.0, 300.0)  # 120E..60W em 0..360


def open_anom(d):
    url = "https://psl.noaa.gov/thredds/dodsC/Datasets/noaa.oisst.v2.highres/sst.day.anom.%d.nc" % d.year
    ds = xr.open_dataset(url, engine="netcdf4")
    # seleciona o dia mais proximo disponivel (<= d)
    times = ds["time"].values
    # filtra dias <= d
    cand = [t for t in times if np.datetime64(t).astype("datetime64[D]") <= np.datetime64(d)]
    if not cand:
        raise RuntimeError("nenhum tempo disponivel <= %s" % d)
    tsel = cand[-1]
    da = ds["anom"].sel(time=tsel, method="nearest")
    return da, np.datetime64(tsel).astype("datetime64[D]").astype(str)


def main():
    today = datetime.date.today()
    da = None
    selected_date = None
    last_err = None
    for offset in range(1, 6):
        d = today - datetime.timedelta(days=offset)
        try:
            da, selected_date = open_anom(d)
            break
        except Exception as e:
            last_err = e
            print("falha para", d, ":", e, file=sys.stderr)
    if da is None:
        print("ERRO: nao foi possivel abrir OISST:", last_err, file=sys.stderr)
        sys.exit(1)

    # subset espacial
    lat_name = "lat"
    lon_name = "lon"
    da = da.sel({lat_name: slice(LAT_RANGE[0], LAT_RANGE[1])})
    da = da.sel({lon_name: slice(LON_RANGE_E[0], LON_RANGE_E[1])})

    # reduz resolucao
    da = da.coarsen({lat_name: COARSEN, lon_name: COARSEN}, boundary="trim").mean()

    lats = da[lat_name].values
    lons = da[lon_name].values
    vals = da.values

    features = []
    for i, lat in enumerate(lats):
        for j, lon in enumerate(lons):
            v = vals[i, j]
            if v is None or (isinstance(v, float) and (np.isnan(v) or np.isinf(v))):
                continue
            lon_deg = float(lon)
            if lon_deg > 180:
                lon_deg -= 360.0
            # centro da celula; tamanho ~2 graus
            half = 1.0
            poly = [
                [lon_deg - half, float(lat) - half],
                [lon_deg + half, float(lat) - half],
                [lon_deg + half, float(lat) + half],
                [lon_deg - half, float(lat) + half],
                [lon_deg - half, float(lat) - half],
            ]
            features.append({
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [poly]},
                "properties": {"anom": round(float(v), 2), "date": str(selected_date)},
            })

    out = {
        "date": str(selected_date),
        "geojson": {"type": "FeatureCollection", "features": features},
        "fonte": "NOAA OISST v2.1 - anomalia diaria (climatologia 1971-2000)",
        "atualizadoEm": datetime.datetime.utcnow().isoformat() + "Z",
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("OK:", len(features), "celulas,", selected_date, "->", OUT_PATH)


if __name__ == "__main__":
    main()
