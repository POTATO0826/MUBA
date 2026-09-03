import { CHART_W, type ChartCard } from "../engine/chart.ts";
import { C } from "../theme.ts";

interface SparklineProps {
  card: ChartCard;
  height: number;
  /** Dot on the last print — used on the live tape, where the line is still growing. */
  head?: boolean;
}

/** Filled area chart with a dashed line at the opening print. */
export function Sparkline({ card, height, head = false }: SparklineProps) {
  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${height}`}
      preserveAspectRatio="none"
      style={{
        width: "100%",
        height,
        display: "block",
        marginTop: 12,
        overflow: "visible",
      }}
    >
      <line
        x1="0"
        x2={CHART_W}
        y1={card.baseY}
        y2={card.baseY}
        stroke={C.border}
        strokeWidth="1"
        strokeDasharray="3 3"
      />
      <path d={card.fill} fill={card.fillColor} />
      <path d={card.path} fill="none" stroke={card.stroke} strokeWidth="1.8" strokeLinejoin="round" />
      {head && <circle cx={card.headX} cy={card.headY} r="2.6" fill={card.stroke} />}
    </svg>
  );
}
