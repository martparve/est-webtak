import base from './vite.config';
import type { ConfigEnv, UserConfig } from 'vite';
export default async (env: ConfigEnv): Promise<UserConfig> => {
    const c = (typeof base === 'function' ? await base(env) : base) as UserConfig;
    c.server = {
        ...(c.server || {}),
        port: 8080,
        proxy: { '/api': { ws: true, target: 'https://map.79-72-16-120.sslip.io', changeOrigin: true, secure: false } }
    };
    return c;
};
