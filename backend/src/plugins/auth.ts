import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import { verifyJWT } from "../routes/auth.js";

declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    userEmail?: string;
  }
}

/**
 * Fastify plugin that adds a `requireAuth` decorator.
 * Usage in routes:
 *   app.get("/my-route", { preHandler: [app.requireAuth] }, handler)
 *
 * Or apply to all routes in a plugin:
 *   app.addHook("onRequest", app.requireAuth)
 */
async function authPlugin(app: FastifyInstance) {
  app.decorate("requireAuth", async function (request: FastifyRequest, reply: FastifyReply) {
    const auth = request.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.code(401).send({ error: "Missing auth token" });
    }
    const decoded = verifyJWT(auth.slice(7));
    if (!decoded || !decoded.userId) {
      return reply.code(401).send({ error: "Invalid or expired token" });
    }
    request.userId = decoded.userId;
    request.userEmail = decoded.email;
  });
}

export default fp(authPlugin, { name: "auth" });
