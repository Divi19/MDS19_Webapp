# GeneX frontend

Next.js workspace for inspecting HER2-positive breast H&E model predictions. The interface keeps the source image primary and displays backend-returned QC, raw model-scale predicted expression, retrieval support, predicted-expression domains, ROI comparisons, pathway evidence, methods, history, and real exports.

## Run locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Required API setting:

```dotenv
NEXT_PUBLIC_API_URL=http://localhost:8000
```

Optional authenticated history:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

Apply both Supabase migrations and create the private `he-images` bucket before enabling history.

## Verify

```bash
npm test
npm run lint
npm run build
```

## Scope

The current real model is restricted to HER2-positive breast H&E tissue. All values are predicted rather than measured and the interface must not be used for diagnosis or clinical decisions.
