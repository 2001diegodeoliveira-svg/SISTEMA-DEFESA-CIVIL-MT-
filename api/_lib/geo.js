/* Utilitarios espaciais leves (sem dependencia externa). */
function toRad(v) { return (v * Math.PI) / 180; }

function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function pointInRing(point, ring) {
  // ray casting; ring: [[lon,lat],...]
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > point[1]) !== (yj > point[1])) &&
      (point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi + 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') {
    if (!pointInRing(point, geometry.coordinates[0])) return false;
    for (let i = 1; i < geometry.coordinates.length; i++) {
      if (pointInRing(point, geometry.coordinates[i])) return false; // hole
    }
    return true;
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((poly) => {
      if (!pointInRing(point, poly[0])) return false;
      for (let i = 1; i < poly.length; i++) {
        if (pointInRing(point, poly[i])) return false;
      }
      return true;
    });
  }
  return false;
}

function featureCentroid(feature) {
  const g = feature && feature.geometry;
  if (!g) return null;
  const pts = [];
  function collect(coords) {
    if (typeof coords[0] === 'number') { pts.push(coords); return; }
    coords.forEach(collect);
  }
  collect(g.coordinates);
  if (!pts.length) return null;
  let sx = 0, sy = 0;
  pts.forEach((p) => { sx += p[0]; sy += p[1]; });
  return [sx / pts.length, sy / pts.length]; // [lon,lat]
}

function bboxOfGeometry(geometry) {
  if (!geometry) return null;
  const pts = [];
  function collect(coords) {
    if (typeof coords[0] === 'number') { pts.push(coords); return; }
    coords.forEach(collect);
  }
  collect(geometry.coordinates);
  if (!pts.length) return null;
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  pts.forEach(([lon, lat]) => {
    minLon = Math.min(minLon, lon); minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon); maxLat = Math.max(maxLat, lat);
  });
  return [minLon, minLat, maxLon, maxLat];
}

module.exports = { distanceKm, pointInPolygon, featureCentroid, bboxOfGeometry };