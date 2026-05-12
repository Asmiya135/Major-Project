import { MapPin } from 'lucide-react';

interface HazardMarker {
  id: string;
  type: 'pothole' | 'flood' | 'debris';
  severity: 'low' | 'medium' | 'high';
  position: { x: number; y: number };
  reports?: number;
}

interface MapPlaceholderProps {
  hazards?: HazardMarker[];
  showRoute?: boolean;
  darkMode?: boolean;
  userPosition?: { x: number; y: number };
  className?: string;
}

export function MapPlaceholder({
  hazards = [],
  showRoute = false,
  darkMode = false,
  userPosition,
  className = ""
}: MapPlaceholderProps) {
  return (
    <div className={`relative w-full h-full rounded-xl overflow-hidden ${
      darkMode ? 'bg-gray-900' : 'bg-gray-100'
    } ${className}`}>
      <div className="absolute inset-0 opacity-20">
        <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path d="M0,30 Q25,20 50,30 T100,30" stroke={darkMode ? "#4b5563" : "#d1d5db"} strokeWidth="0.5" fill="none" />
          <path d="M0,50 Q25,40 50,50 T100,50" stroke={darkMode ? "#4b5563" : "#d1d5db"} strokeWidth="0.5" fill="none" />
          <path d="M0,70 Q25,60 50,70 T100,70" stroke={darkMode ? "#4b5563" : "#d1d5db"} strokeWidth="0.5" fill="none" />
          <path d="M30,0 Q20,25 30,50 T30,100" stroke={darkMode ? "#4b5563" : "#d1d5db"} strokeWidth="0.5" fill="none" />
          <path d="M70,0 Q60,25 70,50 T70,100" stroke={darkMode ? "#4b5563" : "#d1d5db"} strokeWidth="0.5" fill="none" />
        </svg>
      </div>

      {showRoute && (
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
          <path
            d="M20,80 Q35,60 50,50 T80,20"
            stroke="#001E50"
            strokeWidth="0.8"
            fill="none"
            strokeDasharray="2,1"
            opacity="0.8"
          />
        </svg>
      )}

      {hazards.map((hazard) => (
        <div
          key={hazard.id}
          className="absolute group"
          style={{
            left: `${hazard.position.x}%`,
            top: `${hazard.position.y}%`,
            transform: 'translate(-50%, -50%)'
          }}
        >
          <div className={`w-3 h-3 rounded-full cursor-pointer transition-transform hover:scale-125 ${
            hazard.severity === 'high' ? 'bg-red-500' :
            hazard.severity === 'medium' ? 'bg-orange-500' :
            'bg-yellow-500'
          }`}>
            <div className={`absolute inset-0 rounded-full animate-ping opacity-75 ${
              hazard.severity === 'high' ? 'bg-red-500' :
              hazard.severity === 'medium' ? 'bg-orange-500' :
              'bg-yellow-500'
            }`} />
          </div>
          <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
            <div className={`${darkMode ? 'bg-gray-800 text-white' : 'bg-white text-gray-900'} px-3 py-2 rounded-lg shadow-lg whitespace-nowrap text-sm`}>
              <div className="capitalize">{hazard.type}</div>
              <div className="text-xs opacity-75">{hazard.reports || 0} reports</div>
            </div>
          </div>
        </div>
      ))}

      {userPosition && (
        <div
          className="absolute"
          style={{
            left: `${userPosition.x}%`,
            top: `${userPosition.y}%`,
            transform: 'translate(-50%, -50%)'
          }}
        >
          <div className="relative">
            <div className="w-4 h-4 bg-blue-500 rounded-full border-2 border-white shadow-lg" />
            <div className="absolute inset-0 bg-blue-400 rounded-full animate-ping opacity-50" />
          </div>
        </div>
      )}

      <div className={`absolute bottom-4 left-4 px-3 py-1.5 rounded-lg text-xs ${
        darkMode ? 'bg-gray-800/80 text-gray-300' : 'bg-white/80 text-gray-600'
      }`}>
        <MapPin className="w-3 h-3 inline mr-1" />
        Interactive Map
      </div>
    </div>
  );
}
