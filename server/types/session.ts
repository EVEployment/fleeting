/**
 * server/types/session.ts
 *
 * 文件用途: 扩展 @fastify/session 的 Session 接口，消除路由中的 as unknown as Record 类型逃逸
 * 上下文关系: @fastify/session 通过 declare module 'fastify' { interface Session } 扩展 req.session 类型
 */

declare module 'fastify' {
  interface Session {
    userId?: string;
    name?: string;
    roles?: string[];
    oidcAccessToken?: string;
    oidcRefreshToken?: string;
    oidcAccessExpiry?: number;
    oidcState?: string;
    oidcCodeVerifier?: string;
    characters?: Array<{ id: number; name: string }>;
  }
}

export {};
