interface Props {
  value: number;
  max: number;
  onChange: (v: number) => void;
}

export default function TimelineScrubber({ value, max, onChange }: Props) {
  return (
    <div className="scrub-track">
      <input
        type="range"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className="scrub-foot">
        <span>today</span>
        <span>+{max}d</span>
      </div>
    </div>
  );
}
