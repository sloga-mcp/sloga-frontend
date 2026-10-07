/**
 * SVG masks required in components in this library
 */
export function Masks() {
  return (
    <svg width={0} height={0} style={{ position: "fixed" }}>
      <defs>
        <mask id="holepunch-top-left">
          <rect x="0" y="0" width="32" height="32" fill="white" />
          <circle cx="5" cy="5" r="7" fill={"black"} />
        </mask>
        <mask id="holepunch-top-right">
          <rect x="0" y="0" width="32" height="32" fill="white" />
          <circle cx="27" cy="5" r="7" fill={"black"} />
        </mask>
        {/* Wider cut-outs for the multi-digit unread badge — a stadium sized
            to the badge plus its 2px ring, growing leftwards. */}
        <mask id="holepunch-top-right-wide">
          <rect x="0" y="0" width="32" height="32" fill="white" />
          <rect x="16" y="-2" width="18" height="14" rx="7" fill={"black"} />
        </mask>
        <mask id="holepunch-top-right-wider">
          <rect x="0" y="0" width="32" height="32" fill="white" />
          <rect x="11" y="-2" width="23" height="14" rx="7" fill={"black"} />
        </mask>
        <mask id="holepunch-bottom-right">
          <rect x="0" y="0" width="32" height="32" fill="white" />
          <circle cx="27" cy="27" r="7" fill={"black"} />
        </mask>
        <mask id="holepunch-right">
          <rect x="0" y="0" width="32" height="32" fill="white" />
          <circle cx="27" cy="5" r="7" fill={"black"} />
          <circle cx="27" cy="27" r="7" fill={"black"} />
        </mask>
        <mask id="holepunch-overlap">
          <rect x="0" y="0" width="32" height="32" fill="white" />
          <circle cx="32" cy="16" r="18" fill="black" />
        </mask>
        <mask id="holepunch-overlap-subtle">
          <rect x="0" y="0" width="32" height="32" fill="white" />
          <circle cx="33" cy="16" r="18" fill="black" />
        </mask>
        <mask id="accessible-status-offline">
          <circle cx="27" cy="27" r="5" fill="white" />
          <circle cx="27" cy="27" r="3" fill="black" />
        </mask>
        {/* Offline users report "Invisible" (so does someone appearing
            offline), so this is the ring every offline dot actually uses */}
        <mask id="accessible-status-invisible">
          <circle cx="27" cy="27" r="5" fill="white" />
          <circle cx="27" cy="27" r="3" fill="black" />
        </mask>
        <mask id="accessible-status-idle">
          <circle cx="27" cy="27" r="5" fill="white" />
          <circle cx="25" cy="25" r="4" fill="black" />
        </mask>
        <mask id="accessible-status-busy">
          <circle cx="27" cy="27" r="5" fill="white" />
          <line
            x1="24"
            y1="27"
            x2="30"
            y2="27"
            stroke="black"
            stroke-width={2}
          />
        </mask>
        <mask id="accessible-status-focus">
          <circle cx="27" cy="27" r="5" fill="white" />
          <circle cx="27" cy="27" r="4" fill="black" />
          <circle cx="27" cy="27" r="2" fill="white" />
        </mask>
        {/* Looking for more: a "+" cut out of the dot */}
        <mask id="accessible-status-lookingformore">
          <circle cx="27" cy="27" r="5" fill="white" />
          <line
            x1="24"
            y1="27"
            x2="30"
            y2="27"
            stroke="black"
            stroke-width={2}
          />
          <line
            x1="27"
            y1="24"
            x2="27"
            y2="30"
            stroke="black"
            stroke-width={2}
          />
        </mask>
        {/* Looking for group: an up-pointing triangle cut out of the dot */}
        <mask id="accessible-status-lookingforgroup">
          <circle cx="27" cy="27" r="5" fill="white" />
          <polygon points="27,24 30,29.2 24,29.2" fill="black" />
        </mask>
      </defs>
    </svg>
  );
}
