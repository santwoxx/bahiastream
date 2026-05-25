/**
 * Standard WebRTC configurations.
 * Employs Google's free, distributed public STUN servers for peer-to-peer connection NAT traversals.
 */
export const RTC_ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.services.mozilla.com' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ]
};

/**
 * Access the client browser's Screen-Capture Media Stream (Screen Share) safely.
 * Returns the MediaStream containing high-definition video track captures.
 */
export async function captureBrowserScreen(): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    throw new Error('As APIs do navegador para transmissão (getDisplayMedia) não estão disponíveis neste iframe. Abra em uma nova aba!');
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 60 },
        width: { max: 1920 },
        height: { max: 1080 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    
    return stream;
  } catch (err: any) {
    console.error('[WebRTC Services] Erro ao obter sinal de captura de tela:', err);
    throw err;
  }
}
