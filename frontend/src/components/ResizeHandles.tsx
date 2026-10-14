const isTauri = () => Boolean((window as any).__TAURI_INTERNALS__);

type ResizeDirection = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West';

const EDGE = 5;   // px thickness of edge handles
const CORNER = 10; // px size of corner handles

const HANDLES: { dir: ResizeDirection; cursor: string; style: React.CSSProperties }[] = [
  { dir: "North",     cursor: "n-resize",  style: { top: 0,      left: CORNER,  right: CORNER, height: EDGE } },
  { dir: "South",     cursor: "s-resize",  style: { bottom: 0,   left: CORNER,  right: CORNER, height: EDGE } },
  { dir: "East",      cursor: "e-resize",  style: { right: 0,    top: CORNER,   bottom: CORNER, width: EDGE } },
  { dir: "West",      cursor: "w-resize",  style: { left: 0,     top: CORNER,   bottom: CORNER, width: EDGE } },
  { dir: "NorthEast", cursor: "ne-resize", style: { top: 0,      right: 0,      width: CORNER, height: CORNER } },
  { dir: "NorthWest", cursor: "nw-resize", style: { top: 0,      left: 0,       width: CORNER, height: CORNER } },
  { dir: "SouthEast", cursor: "se-resize", style: { bottom: 0,   right: 0,      width: CORNER, height: CORNER } },
  { dir: "SouthWest", cursor: "sw-resize", style: { bottom: 0,   left: 0,       width: CORNER, height: CORNER } },
];

export default function ResizeHandles() {
  if (!isTauri()) return null;

  async function onPointerDown(dir: ResizeDirection) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startResizeDragging(dir);
  }

  return (
    <>
      {HANDLES.map(h => (
        <div
          key={h.dir}
          onPointerDown={e => { e.preventDefault(); onPointerDown(h.dir); }}
          style={{
            position: "fixed",
            zIndex: 9999,
            cursor: h.cursor,
            ...h.style,
          }}
        />
      ))}
    </>
  );
}
