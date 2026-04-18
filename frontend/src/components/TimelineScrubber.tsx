interface Props {
  value: number;
  max: number;
  onChange: (v: number) => void;
}

export default function TimelineScrubber({ value, max, onChange }: Props) {
  return (
    <div className="controls">
      <div className="range">
        <span className="pip">SCRUB</span>
        <input
          type="range"
          min={0}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="pip">+{value}d</span>
      </div>
    </div>
  );
}
