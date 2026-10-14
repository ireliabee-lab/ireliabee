/** The bar you drag to make something taller or shorter (see lib/useDragHeight). */
export default function HeightGrip({ label, className = "", ...props }: { label: string; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`height-grip ${className}`} aria-label={label} {...props}>
      <span className="height-grip-pill" aria-hidden="true" />
    </div>
  );
}
