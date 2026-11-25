// Pure inline SVG vehicle silhouettes for E_BICYCLE, E_MOTORCYCLE/MOTORCYCLE, and CAR.
// Uses currentColor so illustrations inherit theme & card text colour cleanly.

import type { PrivateEvType, RentalVehicleType, VehicleClass } from '@/types/enums';
import { cn } from '@/lib/utils';

export type VehicleIconType = RentalVehicleType | PrivateEvType | VehicleClass;
export type VehicleIconSize = 'sm' | 'md' | 'lg';

export interface VehicleIconProps {
  type: VehicleIconType;
  size?: VehicleIconSize;
  className?: string;
}

const SIZE_CLASSES: Record<VehicleIconSize, string> = {
  sm: 'h-4 w-5',
  md: 'h-6 w-8',
  lg: 'h-8 w-11',
};

export function VehicleIcon({ type, size = 'md', className }: VehicleIconProps) {
  const classes = cn('shrink-0', SIZE_CLASSES[size], className);

  if (type === 'E_BICYCLE') {
    return (
      <svg
        viewBox="0 0 36 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={classes}
      >
        {/* Two spoked wheels */}
        <circle cx="8" cy="17.5" r="4.5" />
        <circle cx="28" cy="17.5" r="4.5" />
        {/* Step-through frame */}
        <path d="M8 17.5 L15 17.5 L23 9.5 L28 17.5" />
        <path d="M15 17.5 L12.5 9.5 L10 9.5" />
        {/* Downtube battery pack */}
        <path d="M17.5 14.5 L21.5 10.5" strokeWidth="3.2" opacity="0.45" />
        {/* Handlebars */}
        <path d="M23 9.5 L22 6 L25.5 6" />
      </svg>
    );
  }

  if (type === 'CAR') {
    return (
      <svg
        viewBox="0 0 36 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={classes}
      >
        {/* Compact EV body & cabin */}
        <path
          d="M4.5 16.5 V13 C4.5 11.7 5.4 10.8 6.7 10.5 L10.2 6.2 C11 5.3 12.1 4.8 13.3 4.8 H22.5 C23.9 4.8 25.1 5.5 25.9 6.6 L28.8 10.5 C30.6 10.9 31.8 12.1 31.8 13.7 V16.5 H29.5"
          fill="currentColor"
          fillOpacity="0.08"
        />
        <path d="M13.5 16.5 H22.5" />
        <path d="M4.5 16.5 H6.5" />
        {/* Wheels */}
        <circle cx="10" cy="17" r="3.2" />
        <circle cx="26" cy="17" r="3.2" />
        {/* Subtle electric bolt accent */}
        <path d="M18.6 7.4 L16.7 10.4 H18.7 L17.3 13" strokeWidth="1.4" />
      </svg>
    );
  }

  // E_MOTORCYCLE / MOTORCYCLE
  return (
    <svg
      viewBox="0 0 36 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={classes}
    >
      {/* Thicker scooter/e-motorcycle wheels */}
      <circle cx="8.5" cy="17.5" r="4.2" />
      <circle cx="27.5" cy="17.5" r="4.2" />
      {/* Rear deck, seat, step footrest, and front fairing */}
      <path
        d="M7 13.5 H16.5 L19.5 17 H23.5 L25.5 9.5 C26.2 7.2 27.6 6.2 29.5 6.2"
        fill="currentColor"
        fillOpacity="0.08"
      />
      <path d="M10 10.5 H17" strokeWidth="2.4" />
      <path d="M24 5.5 L26.5 9.5 L27.5 17.5" />
    </svg>
  );
}
