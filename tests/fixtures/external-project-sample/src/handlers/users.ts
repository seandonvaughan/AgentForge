/**
 * Users route handler — CRUD for the User resource.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  createdAt: z.string().datetime(),
});

type User = z.infer<typeof UserSchema>;

// In-memory store
const users = new Map<string, User>();

export const usersRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/', async () => Array.from(users.values()));

  fastify.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const user = users.get(req.params.id);
    if (!user) return reply.code(404).send({ error: 'Not found' });
    return user;
  });
};
