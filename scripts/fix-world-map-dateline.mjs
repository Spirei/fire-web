import fs from "node:fs";

const mapPath = new URL("../public/maps-world.json", import.meta.url);
const world = JSON.parse(fs.readFileSync(mapPath, "utf8"));

// Antarctica has no economic-series payload and its pole-spanning ring creates
// an unnecessary seam at the bottom of an equirectangular world map.
world.features = world.features.filter((feature) => feature.properties?.name !== "Antarctica");

// Natural Earth stores Fiji on both sides of the date line. ECharts draws the
// literal -180 -> +180 segment, so keep every affected ring continuous on one
// side of the line before registering the GeoJSON map.
const fiji = world.features.find((feature) => feature.properties?.name === "Fiji");
if (fiji?.geometry?.type === "MultiPolygon") {
  for (const polygon of fiji.geometry.coordinates) {
    for (const ring of polygon) {
      const crossesDateLine = ring.some((point, index) => (
        index > 0 && Math.abs(point[0] - ring[index - 1][0]) > 180
      ));
      if (!crossesDateLine) continue;

      const positiveCount = ring.filter(([longitude]) => longitude >= 0).length;
      const moveToEast = positiveCount >= ring.length - positiveCount;
      for (const point of ring) {
        if (moveToEast && point[0] < 0) point[0] += 360;
        if (!moveToEast && point[0] > 0) point[0] -= 360;
      }
    }
  }
}

fs.writeFileSync(mapPath, JSON.stringify(world));
