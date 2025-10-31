export const config = {
  pwaEnabled: false,
  sounds: true,
  maxLines: 6,
  lockMs: 200
};

if (typeof window !== "undefined") window.config = config;