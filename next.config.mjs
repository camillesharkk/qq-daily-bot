/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return [{ source: "/api/mcp/", destination: "/api/mcp" }];
  },
};

export default nextConfig;
