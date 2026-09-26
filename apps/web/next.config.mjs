import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// One .env at the repo root serves both the backend and the web app.
const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env') });

const backendUrl = process.env.BACKEND_URL || 'http://localhost:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Off: Strict Mode runs effects twice in dev, so the IDKit widget would create the World ID
  // request twice with the same single-use rp_context and World App rejects the QR as expired.
  reactStrictMode: false,
  transpilePackages: ['@mysten/dapp-kit-react', '@mysten/dapp-kit-core', '@mysten/sui'],
  // Same-origin API: the World ID session cookie stays first-party.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${backendUrl}/api/:path*` }];
  },
};

export default nextConfig;
