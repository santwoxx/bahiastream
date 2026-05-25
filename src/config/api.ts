const IS_PROD = (import.meta as any).env?.PROD;
export const API_URL = IS_PROD ? 'https://bahiastream.onrender.com' : '';
