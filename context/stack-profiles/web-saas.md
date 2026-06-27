# Web SaaS Stack Profile

## Languages & Frameworks
- **Frontend**: Next.js 14 App Router, TypeScript strict, Tailwind CSS, shadcn/ui components
- **Backend**: Node.js + Fastify or Next.js Route Handlers, TypeScript
- **Database**: PostgreSQL + Prisma ORM
- **Auth**: NextAuth.js v5 / Auth.js
- **Realtime**: Socket.io or Pusher
- **State**: Zustand or React Query (TanStack)
- **Deployment**: Docker + AWS ECS or Vercel + PlanetScale

## Coding Standards
- App Router ONLY — no Pages Router
- Server Components by default; Client Components only when necessary (hooks, browser APIs)
- API routes at `app/api/[route]/route.ts` using Route Handlers
- No raw SQL except for complex queries — use Prisma
- Zod for all input validation at API boundaries
- Error responses: `{ error: string; code: string }` format
- Environment variables validated at startup with Zod

## Project Structure
```
src/
  app/           # Next.js App Router
    api/         # Route handlers
    (auth)/      # Auth group routes
  components/    # Shared UI components
    ui/          # shadcn/ui primitives
  lib/           # Utilities, DB client, auth config
  hooks/         # Client-side hooks
  types/         # TypeScript interfaces
  store/         # Zustand stores
```

## Testing Stack
- **Unit/Integration**: Vitest + @testing-library/react
- **API**: Supertest
- **E2E**: Playwright
- **File naming**: `*.test.ts` or `*.spec.ts`
- **Mocking**: vi.mock() for modules, MSW for HTTP

## Common Patterns
- Auth: middleware.ts at root for route protection
- DB: `src/lib/db.ts` exports Prisma client singleton
- API: always validate with Zod, return typed responses
- Components: compound component pattern for complex UI
