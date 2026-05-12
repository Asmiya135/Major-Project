interface SeverityBadgeProps {
  severity: 'low' | 'medium' | 'high';
  className?: string;
}

export function SeverityBadge({ severity, className = "" }: SeverityBadgeProps) {
  const colors = {
    low: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    medium: 'bg-orange-100 text-orange-800 border-orange-300',
    high: 'bg-red-100 text-red-800 border-red-300',
  };

  return (
    <div className={`inline-flex items-center px-2 py-0.5 rounded-full border ${colors[severity]} ${className}`}>
      <div className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
        severity === 'high' ? 'bg-red-600' :
        severity === 'medium' ? 'bg-orange-600' :
        'bg-yellow-600'
      }`} />
      <span className="text-xs capitalize">{severity}</span>
    </div>
  );
}
