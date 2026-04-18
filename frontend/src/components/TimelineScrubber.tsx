interface Props {
  value: number;
  max: number;
  onChange: (v: number) => void;
  horizon: number;
  onHorizonChange: (h: number) => void;
}

const HORIZONS: { label: string; days: number }[] = [
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
];

export default function TimelineScrubber({ value, max, onChange, horizon, onHorizonChange }: Props) {
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
      <div className="seg" role="group">
        {HORIZONS.map(({ label, days }) => (
          <button
            key={label}
            aria-pressed={horizon === days ? 'true' : 'false'}
            onClick={() => onHorizonChange(days)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
