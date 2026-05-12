import { AlertTriangle, Droplets, Trash2 } from 'lucide-react';

interface HazardIconProps {
  type: 'pothole' | 'flood' | 'debris';
  className?: string;
}

export function HazardIcon({ type, className = "w-5 h-5" }: HazardIconProps) {
  switch (type) {
    case 'pothole':
      return <AlertTriangle className={className} />;
    case 'flood':
      return <Droplets className={className} />;
    case 'debris':
      return <Trash2 className={className} />;
    default:
      return <AlertTriangle className={className} />;
  }
}
