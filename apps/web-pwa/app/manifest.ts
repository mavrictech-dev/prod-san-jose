import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'FactuEz — Grifo San José',
    short_name: 'FactuEz',
    description: 'Facturación electrónica para Grifo San José S.R.L.',
    display: 'standalone',
    start_url: '/',
    background_color: '#ffffff',
    theme_color: '#18181b',
    icons: [{ src: '/brand/factuez-modo-claro.webp', sizes: '512x512', type: 'image/webp' }],
  };
}
