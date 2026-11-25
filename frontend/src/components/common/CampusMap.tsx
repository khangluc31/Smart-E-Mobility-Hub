// Pure inline SVG schematic map of the 5 campus Mobility Hubs (D-12, NFR-04, NFR-28).
// Zero external map libraries; scales cleanly down to 360 px width.

import { useId, type KeyboardEvent } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export interface CampusMapHub {
  id: string;
  name: string;
  degraded: boolean;
  nearCapacity: boolean;
  availableVehicles: number;
  redirectToHubId?: string | null;
  openAlerts?: number;
}

export interface CampusMapProps {
  hubs: CampusMapHub[];
  onSelectHub: (hubId: string) => void;
  selectedHubId?: string | null;
  title?: string;
  subtitle?: string;
}

interface HubCoord {
  x: number;
  y: number;
  shortLabel: string;
}

const HUB_COORDS: Record<string, HubCoord> = {
  metro: { x: 96, y: 172, shortLabel: 'Metro' },
  dorm: { x: 226, y: 76, shortLabel: 'Dorm' },
  'campus-a': { x: 356, y: 152, shortLabel: 'Campus A' },
  'campus-b': { x: 520, y: 96, shortLabel: 'Campus B' },
  service: { x: 468, y: 256, shortLabel: 'Service' },
};

const CORRIDORS: ReadonlyArray<readonly [string, string]> = [
  ['metro', 'dorm'],
  ['metro', 'campus-a'],
  ['dorm', 'campus-a'],
  ['campus-a', 'campus-b'],
  ['campus-a', 'service'],
  ['campus-b', 'service'],
];

const PIN_RADIUS = 18;

function pinPalette(hub: CampusMapHub): {
  fill: string;
  stroke: string;
  statusText: string;
} {
  if (hub.degraded) {
    return { fill: '#dc2626', stroke: '#991b1b', statusText: 'Degraded' };
  }
  if (hub.nearCapacity) {
    return { fill: '#d97706', stroke: '#92400e', statusText: 'Near capacity' };
  }
  return { fill: '#059669', stroke: '#065f46', statusText: 'Healthy' };
}

function buildRedirectPath(from: HubCoord, to: HubCoord): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist;
  const uy = dy / dist;

  // Start and end cleanly outside the pin circles
  const sx = from.x + ux * (PIN_RADIUS + 6);
  const sy = from.y + uy * (PIN_RADIUS + 6);
  const tx = to.x - ux * (PIN_RADIUS + 10);
  const ty = to.y - uy * (PIN_RADIUS + 10);

  // Subtle perpendicular offset for a clean curved arc
  const mx = (sx + tx) / 2;
  const my = (sy + ty) / 2;
  const curveOffset = Math.min(34, dist * 0.18);
  const cx = mx - uy * curveOffset;
  const cy = my + ux * curveOffset;

  return `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`;
}

export function CampusMap({
  hubs,
  onSelectHub,
  selectedHubId = null,
  title = 'Campus Hub Map',
  subtitle = 'Select any Hub pin to inspect live availability and resources.',
}: CampusMapProps) {
  const rawId = useId();
  const arrowMarkerId = `campus-redirect-arrow-${rawId.replace(/:/g, '')}`;

  const mappedHubs = hubs
    .map((hub) => {
      const coord = HUB_COORDS[hub.id];
      return coord ? { hub, coord } : null;
    })
    .filter((item): item is { hub: CampusMapHub; coord: HubCoord } => item !== null);

  const redirects = mappedHubs
    .map(({ hub, coord }) => {
      if (!hub.redirectToHubId || hub.redirectToHubId === hub.id) return null;
      const target = HUB_COORDS[hub.redirectToHubId];
      if (!target) return null;
      return {
        key: `${hub.id}->${hub.redirectToHubId}`,
        fromName: hub.name,
        toId: hub.redirectToHubId,
        d: buildRedirectPath(coord, target),
      };
    })
    .filter(
      (item): item is { key: string; fromName: string; toId: string; d: string } => item !== null,
    );

  function handlePinKeyDown(e: KeyboardEvent<SVGGElement>, hubId: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectHub(hubId);
    }
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription className="text-xs">{subtitle}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        <div className="rounded-md border bg-slate-50/70 dark:bg-slate-900/30 p-2 overflow-hidden">
          <svg
            viewBox="0 0 640 340"
            className="w-full h-auto block select-none"
            role="img"
            aria-label={`Campus schematic map showing ${mappedHubs.length} Mobility Hubs`}
          >
            <defs>
              <marker
                id={arrowMarkerId}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 1.5 L 9 5 L 0 8.5 z" fill="#0284c7" />
              </marker>
            </defs>

            {/* Schematic campus zones */}
            <rect
              x="16"
              y="16"
              width="608"
              height="308"
              rx="18"
              fill="#f8fafc"
              stroke="#e2e8f0"
              strokeWidth="1.5"
            />
            <rect
              x="36"
              y="120"
              width="124"
              height="108"
              rx="12"
              fill="#eef2ff"
              stroke="#cbd5e1"
              strokeWidth="1"
            />
            <text x="48" y="138" fontSize="9.5" fill="#64748b" fontWeight="600">
              TRANSIT GATE
            </text>

            <rect
              x="162"
              y="32"
              width="138"
              height="86"
              rx="12"
              fill="#f0fdf4"
              stroke="#cbd5e1"
              strokeWidth="1"
            />
            <text x="174" y="48" fontSize="9.5" fill="#64748b" fontWeight="600">
              NORTH DORMS
            </text>

            <rect
              x="284"
              y="108"
              width="148"
              height="92"
              rx="12"
              fill="#eff6ff"
              stroke="#cbd5e1"
              strokeWidth="1"
            />
            <text x="296" y="124" fontSize="9.5" fill="#64748b" fontWeight="600">
              ACADEMIC QUAD
            </text>

            <rect
              x="456"
              y="46"
              width="144"
              height="94"
              rx="12"
              fill="#fefce8"
              stroke="#cbd5e1"
              strokeWidth="1"
            />
            <text x="468" y="62" fontSize="9.5" fill="#64748b" fontWeight="600">
              EAST CAMPUS
            </text>

            <rect
              x="392"
              y="214"
              width="164"
              height="88"
              rx="12"
              fill="#f1f5f9"
              stroke="#cbd5e1"
              strokeWidth="1"
            />
            <text x="404" y="230" fontSize="9.5" fill="#64748b" fontWeight="600">
              SERVICE &amp; DEPOT
            </text>

            {/* Campus mobility corridors */}
            <g stroke="#cbd5e1" strokeWidth="3.5" strokeLinecap="round">
              {CORRIDORS.map(([aId, bId]) => {
                const a = HUB_COORDS[aId];
                const b = HUB_COORDS[bId];
                if (!a || !b) return null;
                return <line key={`${aId}-${bId}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
              })}
            </g>

            {/* Active Hub redirect arrows */}
            {redirects.map((red) => (
              <path
                key={red.key}
                d={red.d}
                fill="none"
                stroke="#0284c7"
                strokeWidth="2.5"
                strokeDasharray="6 4"
                markerEnd={`url(#${arrowMarkerId})`}
              >
                <title>{`Active redirect from ${red.fromName} to ${red.toId}`}</title>
              </path>
            ))}

            {/* 5 Mobility Hub pins */}
            {mappedHubs.map(({ hub, coord }) => {
              const palette = pinPalette(hub);
              const isSelected = selectedHubId === hub.id;
              const alertsCount = hub.openAlerts ?? 0;
              const ariaLabel = [
                hub.name,
                palette.statusText,
                `${hub.availableVehicles} available rental vehicles`,
                alertsCount > 0 ? `${alertsCount} open alerts` : null,
                hub.redirectToHubId ? `redirecting to ${hub.redirectToHubId}` : null,
              ]
                .filter(Boolean)
                .join(', ');

              return (
                <g
                  key={hub.id}
                  role="button"
                  tabIndex={0}
                  aria-label={ariaLabel}
                  onClick={() => onSelectHub(hub.id)}
                  onKeyDown={(e) => handlePinKeyDown(e, hub.id)}
                  className="cursor-pointer focus:outline-none group"
                >
                  <title>{ariaLabel}</title>

                  {/* Selection halo */}
                  {isSelected && (
                    <circle
                      cx={coord.x}
                      cy={coord.y}
                      r={PIN_RADIUS + 9}
                      fill="none"
                      stroke="#0f172a"
                      strokeWidth="2.5"
                      opacity="0.85"
                    />
                  )}

                  {/* Degraded dashed outer ring */}
                  {hub.degraded && (
                    <circle
                      cx={coord.x}
                      cy={coord.y}
                      r={PIN_RADIUS + 5}
                      fill="none"
                      stroke="#dc2626"
                      strokeWidth="2"
                      strokeDasharray="4 3"
                    />
                  )}

                  {/* Main status pin */}
                  <circle
                    cx={coord.x}
                    cy={coord.y}
                    r={PIN_RADIUS}
                    fill={palette.fill}
                    stroke="#ffffff"
                    strokeWidth="2.5"
                  />

                  {/* Available vehicle count inside pin */}
                  <text
                    x={coord.x}
                    y={coord.y + 4}
                    textAnchor="middle"
                    fontSize="11.5"
                    fontWeight="700"
                    fill="#ffffff"
                  >
                    {hub.availableVehicles}
                  </text>

                  {/* Open alerts badge (Operator Dashboard) */}
                  {alertsCount > 0 && (
                    <g>
                      <circle
                        cx={coord.x + 15}
                        cy={coord.y - 15}
                        r="9"
                        fill="#b91c1c"
                        stroke="#ffffff"
                        strokeWidth="1.5"
                      />
                      <text
                        x={coord.x + 15}
                        y={coord.y - 11.5}
                        textAnchor="middle"
                        fontSize="9"
                        fontWeight="700"
                        fill="#ffffff"
                      >
                        {alertsCount > 9 ? '9+' : alertsCount}
                      </text>
                    </g>
                  )}

                  {/* Concise label pill beneath pin */}
                  <rect
                    x={coord.x - 38}
                    y={coord.y + PIN_RADIUS + 5}
                    width="76"
                    height="18"
                    rx="9"
                    fill="#ffffff"
                    stroke="#cbd5e1"
                    strokeWidth="1"
                  />
                  <text
                    x={coord.x}
                    y={coord.y + PIN_RADIUS + 17}
                    textAnchor="middle"
                    fontSize="10.5"
                    fontWeight="600"
                    fill="#0f172a"
                  >
                    {coord.shortLabel}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Responsive legend (NFR-28: wraps cleanly at 360 px) */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-600 inline-block shrink-0" />
            <span>Healthy</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-amber-600 inline-block shrink-0" />
            <span>Near capacity</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-600 ring-1 ring-red-600 ring-offset-1 inline-block shrink-0" />
            <span>Degraded</span>
          </span>
          {redirects.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="w-4 border-t-2 border-dashed border-sky-600 inline-block shrink-0" />
              <span>Active redirect</span>
            </span>
          )}
          <span className="ml-auto text-[11px]">Pin number = available rental vehicles</span>
        </div>
      </CardContent>
    </Card>
  );
}
