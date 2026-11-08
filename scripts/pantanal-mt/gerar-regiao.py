"""
Gera api/_lib/pantanal-mt.json: delimitação da região do Pantanal em Mato Grosso.

Fontes oficiais do IBGE (SIRGAS 2000, EPSG:4674; tratadas como WGS84, diferença < 1 m):
  - Biomas 1:250.000 (bioma "Pantanal"):
    https://geoftp.ibge.gov.br/informacoes_ambientais/estudos_ambientais/biomas/vetores/Biomas_250mil.zip
  - Malha municipal de MT 2022 (CD_MUN, NM_MUN):
    https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/malhas_municipais/municipio_2022/UFs/MT/MT_Municipios_2022.zip

Regra: a região é Pantanal ∩ Mato Grosso. Um município entra na lista quando pelo
menos MIN_PCT da sua área está dentro do bioma (evita fatias de borda).

Uso (requer pyshp e shapely):
  python scripts/pantanal-mt/gerar-regiao.py
"""
import io
import json
import os
import urllib.request
import zipfile
from datetime import date

import shapefile
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

BIOMAS_URL = "https://geoftp.ibge.gov.br/informacoes_ambientais/estudos_ambientais/biomas/vetores/Biomas_250mil.zip"
MT_URL = "https://geoftp.ibge.gov.br/organizacao_do_territorio/malhas_territoriais/malhas_municipais/municipio_2022/UFs/MT/MT_Municipios_2022.zip"
MIN_PCT = 0.01
SIMPLIFICA = 0.002
SAIDA = os.path.join(os.path.dirname(__file__), "..", "..", "api", "_lib", "pantanal-mt.json")


def baixar_shapefile(url, pasta_base):
    with urllib.request.urlopen(url, timeout=300) as r:
        dados = r.read()
    with zipfile.ZipFile(io.BytesIO(dados)) as z:
        z.extractall(pasta_base)
    for raiz, _, nomes in os.walk(pasta_base):
        for n in nomes:
            if n.lower().endswith(".shp"):
                return os.path.join(raiz, n)
    raise RuntimeError("shapefile não encontrado em " + url)


def arredonda(coords, casas=4):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], casas), round(coords[1], casas)]
    return [arredonda(c, casas) for c in coords]


def main():
    import tempfile
    pasta = tempfile.mkdtemp(prefix="ibge-")
    shp_bio = baixar_shapefile(BIOMAS_URL, os.path.join(pasta, "biomas"))
    shp_mt = baixar_shapefile(MT_URL, os.path.join(pasta, "mt"))

    bio = shapefile.Reader(shp_bio, encoding="utf-8")
    campos = [f[0] for f in bio.fields[1:]]
    i_bioma = campos.index("Bioma")
    partes = [shape(s.__geo_interface__) for s, r in zip(bio.shapes(), bio.records())
              if "pantanal" in str(r[i_bioma]).lower()]
    pantanal = unary_union(partes)

    mt = shapefile.Reader(shp_mt, encoding="utf-8")
    campos_mt = [f[0] for f in mt.fields[1:]]
    i_cd, i_nm = campos_mt.index("CD_MUN"), campos_mt.index("NM_MUN")
    municipios = []
    for s, r in zip(mt.shapes(), mt.records()):
        g = shape(s.__geo_interface__)
        if g.area == 0:
            continue
        pct = g.intersection(pantanal).area / g.area
        if pct >= MIN_PCT:
            municipios.append({"codigo": str(r[i_cd]), "nome": str(r[i_nm]), "percentualNoBioma": round(pct * 100, 2)})
    municipios.sort(key=lambda m: -m["percentualNoBioma"])

    mt_geom = unary_union([shape(s.__geo_interface__) for s in mt.shapes()])
    regiao = pantanal.intersection(mt_geom).simplify(SIMPLIFICA, preserve_topology=True)
    geo = {
        "type": "Feature",
        "properties": {"nome": "Pantanal (Mato Grosso)", "bioma": "Pantanal", "uf": "MT"},
        "geometry": {"type": regiao.geom_type, "coordinates": arredonda(mapping(regiao)["coordinates"])},
    }

    saida = {
        "regiao": "Pantanal (Mato Grosso)",
        "geradoEm": date.today().isoformat(),
        "criterio": "Pantanal (bioma IBGE 1:250.000) interseccionado com MT; município entra com >= %.0f%% da área no bioma." % (MIN_PCT * 100),
        "fontes": [BIOMAS_URL, MT_URL],
        "bbox": [round(x, 4) for x in regiao.bounds],
        "municipios": municipios,
        "geojson": geo,
    }
    caminho = os.path.abspath(SAIDA)
    with open(caminho, "w", encoding="utf-8") as f:
        json.dump(saida, f, ensure_ascii=False, separators=(",", ":"))
    print("municipios:", len(municipios), "| bbox:", saida["bbox"], "| bytes:", os.path.getsize(caminho))


if __name__ == "__main__":
    main()
