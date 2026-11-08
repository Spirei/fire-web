export type CropPoint = { x: number; y: number };
export const clampCrop = (n: number) => Math.max(-1, Math.min(1, n));

export function cropGeometry(image: { width: number; height: number }, frame: { width: number; height: number }, zoom: number, position: CropPoint) {
  const scale = Math.max(frame.width / image.width, frame.height / image.height) * Math.max(1, Math.min(4, zoom));
  const width = image.width * scale, height = image.height * scale;
  const overflowX = Math.max(0, (width - frame.width) / 2), overflowY = Math.max(0, (height - frame.height) / 2);
  const left = -overflowX + clampCrop(position.x) * overflowX, top = -overflowY + clampCrop(position.y) * overflowY;
  return { width, height, left, top, overflowX, overflowY, sx: -left / scale, sy: -top / scale, sw: frame.width / scale, sh: frame.height / scale };
}
