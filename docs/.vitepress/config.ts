import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const SITE_DESCRIPTION =
  "Build reliable workflow applications with end-to-end type safety, automatic schema validation, and type-safe contracts for Temporal.io workflows and activities in TypeScript";

// Versioned deploys (deploy-docs.yml): while a prerelease is in progress the
// workflow builds main's docs a second time as the "beta" site, overriding the
// base to /temporal-contract/beta/ via DOCS_BASE; the stable site (built from
// the latest stable tag) stays at the root. Absent env — local dev, plain
// builds — keeps today's root base.
// Normalized to a guaranteed leading + trailing slash so a DOCS_BASE typed
// without one in CI cannot corrupt asset routing or canonical URLs.
const RAW_BASE = process.env.DOCS_BASE ?? "/temporal-contract/";
const BASE = `/${RAW_BASE.replace(/^\/+|\/+$/g, "")}/`;
const SITE_URL = `https://btravstack.github.io${BASE}`;

// DOCS_VERSIONS — the marker the deploy workflow probes for to detect native
// version-picker support (legacy tags without it get the dropdown injected at
// build time instead). JSON: { current: string, items: { text, link }[] } —
// rendered as a dropdown at the end of the nav, linking every deployed version
// with absolute URLs (cross-version links must not inherit this build's base).
// Absent env → no dropdown (single-version site, local dev).
const DOCS_VERSIONS = process.env.DOCS_VERSIONS
  ? (JSON.parse(process.env.DOCS_VERSIONS) as {
      current: string;
      items: { text: string; link: string }[];
    })
  : undefined;
const VERSION_NAV = DOCS_VERSIONS
  ? [{ text: DOCS_VERSIONS.current, items: DOCS_VERSIONS.items }]
  : [];

// The docs are structured by the four Diátaxis modes (https://diataxis.fr/):
// a learning-oriented Tutorial, task-oriented How-to guides,
// information-oriented Reference, and understanding-oriented Explanation. One
// shared sidebar carries all four so any page can reach any other.
const DOCS_SIDEBAR = [
  {
    text: "Tutorial",
    items: [
      { text: "Your first workflow", link: "/tutorial/your-first-workflow" },
      { text: "Adding signals and queries", link: "/tutorial/adding-signals-and-queries" },
    ],
  },
  {
    text: "How-to guides",
    items: [
      { text: "Install temporal-contract", link: "/how-to/install" },
      { text: "Define a contract", link: "/how-to/define-a-contract" },
      { text: "Implement activities", link: "/how-to/implement-activities" },
      { text: "Model domain errors", link: "/how-to/model-domain-errors" },
      {
        text: "Use signals, queries, and updates",
        link: "/how-to/use-signals-queries-and-updates",
      },
      {
        text: "Index with search attributes",
        link: "/how-to/index-workflows-with-search-attributes",
      },
      { text: "Run child workflows", link: "/how-to/run-child-workflows" },
      { text: "Handle cancellation", link: "/how-to/handle-cancellation" },
      { text: "Continue as new", link: "/how-to/continue-as-new" },
      { text: "Tune activity options", link: "/how-to/tune-activity-options" },
      { text: "Add activity middleware", link: "/how-to/add-activity-middleware" },
      { text: "Intercept client calls", link: "/how-to/intercept-client-calls" },
      { text: "Schedule workflows", link: "/how-to/schedule-workflows" },
      { text: "Configure a worker", link: "/how-to/configure-a-worker" },
      { text: "Test workflows", link: "/how-to/test-workflows" },
      { text: "Upgrade from 7.x to 8.0", link: "/how-to/upgrade-to-v8" },
      { text: "Migrate from neverthrow", link: "/how-to/migrate-from-neverthrow" },
      { text: "Troubleshoot", link: "/how-to/troubleshoot" },
    ],
  },
  {
    text: "Reference",
    items: [
      { text: "Contract surface", link: "/reference/contract-surface" },
      { text: "Worker surface", link: "/reference/worker-surface" },
      { text: "Client surface", link: "/reference/client-surface" },
      { text: "Testing surface", link: "/reference/testing-surface" },
      { text: "Errors", link: "/reference/errors" },
      { text: "Glossary", link: "/reference/glossary" },
      { text: "API reference", link: "/api/" },
    ],
  },
  {
    text: "Explanation",
    items: [
      { text: "Why temporal-contract?", link: "/explanation/why-temporal-contract" },
      { text: "The result model", link: "/explanation/the-result-model" },
      { text: "Validation boundaries", link: "/explanation/validation-boundaries" },
      { text: "Workflow determinism", link: "/explanation/workflow-determinism" },
      { text: "Architecture", link: "/explanation/architecture" },
      { text: "Nexus", link: "/explanation/nexus" },
    ],
  },
  {
    text: "Examples",
    items: [{ text: "Order processing", link: "/examples/" }],
  },
];

// https://vitepress.dev/reference/site-config
export default withMermaid(
  defineConfig({
    title: "temporal-contract",
    description: SITE_DESCRIPTION,
    base: BASE,
    lang: "en-US",

    // `docs/superpowers/**` holds internal planning/spec documents for this
    // repo's own development process, not end-user documentation. Without
    // this exclusion VitePress builds and publishes them like any other
    // page, and `deploy-docs.yml` (triggered on `push` to `main` with
    // `paths: ["docs/**"]`) would ship them to the public site.
    //
    // The directory is currently absent — the guard is kept deliberately,
    // because that workflow writes its specs and plans back to this path and
    // the exclusion must already exist when it does. Deleting it as "dead
    // config" would silently publish the next batch.
    srcExclude: ["superpowers/**"],

    // `@btravstack/theme` re-exports VitePress's default theme, which imports
    // `.css`. Externalizing it during SSR makes Node try to `import` those
    // stylesheets and throw `ERR_UNKNOWN_FILE_EXTENSION`. Transform the theme
    // package through Vite instead so the CSS imports are handled.
    vite: {
      ssr: {
        noExternal: ["@btravstack/theme"],
      },
    },

    ignoreDeadLinks: [
      // Ignore localhost links as they're for development examples
      /^http:\/\/localhost/,
      // API docs are generated separately and may not exist during build
      /^\/api\//,
      // Ignore relative links in API docs (typedoc-generated cross-references)
      /^\.\/index$/,
      /^\.\/[a-z-]+$/,
    ],

    sitemap: {
      hostname: SITE_URL,
    },

    // Inject canonical URLs and dynamic meta tags for each page to prevent duplicate content issues
    transformPageData(pageData) {
      // Only process markdown files
      if (!pageData.relativePath.endsWith(".md")) {
        return;
      }

      // VitePress provides relativePath without leading slash (e.g.,
      // "tutorial/your-first-workflow.md"). Normalize by removing any leading
      // slashes just in case. `SITE_URL` already carries this build's base, so
      // the beta site canonicalizes to /beta/ URLs rather than the stable ones.
      const normalizedPath = pageData.relativePath.replace(/^\/+/, "");
      const canonicalUrl = `${SITE_URL}${normalizedPath}`
        .replace(/index\.md$/, "")
        .replace(/\.md$/, ".html");

      // Ensure frontmatter and head array exist
      pageData.frontmatter ??= {};
      pageData.frontmatter.head ??= [];

      // Add canonical URL
      pageData.frontmatter.head.push(["link", { rel: "canonical", href: canonicalUrl }]);

      // Add dynamic Open Graph tags
      const pageTitle = pageData.title || pageData.frontmatter.title || "temporal-contract";
      const pageDescription =
        pageData.description || pageData.frontmatter.description || SITE_DESCRIPTION;

      pageData.frontmatter.head.push(
        ["meta", { property: "og:url", content: canonicalUrl }],
        ["meta", { property: "og:title", content: pageTitle }],
        ["meta", { property: "og:description", content: pageDescription }],
      );

      // Add dynamic Twitter Card tags
      pageData.frontmatter.head.push(
        ["meta", { name: "twitter:title", content: pageTitle }],
        ["meta", { name: "twitter:description", content: pageDescription }],
      );
    },

    // Mermaid configuration
    mermaidPlugin: {
      class: "mermaid",
    },

    themeConfig: {
      // https://vitepress.dev/reference/default-theme-config
      logo: { light: "/logo-light.svg", dark: "/logo-dark.svg" },

      nav: [
        { text: "Tutorial", link: "/tutorial/your-first-workflow" },
        { text: "How-to", link: "/how-to/install" },
        { text: "Reference", link: "/reference/contract-surface" },
        { text: "Explanation", link: "/explanation/why-temporal-contract" },
        { text: "API", link: "/api/" },
        { text: "Changelog", link: "https://github.com/btravstack/temporal-contract/releases" },
        // Back to the btravstack hub (links the docs up to the landing page).
        { text: "btravstack", link: "https://btravstack.github.io/" },
        // Version dropdown — present only on versioned (prerelease) deploys.
        ...VERSION_NAV,
      ],

      sidebar: {
        "/tutorial/": DOCS_SIDEBAR,
        "/how-to/": DOCS_SIDEBAR,
        "/reference/": DOCS_SIDEBAR,
        "/explanation/": DOCS_SIDEBAR,
        "/examples/": DOCS_SIDEBAR,
        "/api/": [
          {
            text: "Core Packages",
            items: [
              { text: "Overview", link: "/api/" },
              { text: "@temporal-contract/contract", link: "/api/contract/" },
              { text: "@temporal-contract/client", link: "/api/client/" },
              { text: "@temporal-contract/worker", link: "/api/worker/" },
            ],
          },
          {
            text: "Testing",
            items: [{ text: "@temporal-contract/testing", link: "/api/testing/" }],
          },
          {
            text: "Docs",
            items: [
              { text: "Reference", link: "/reference/contract-surface" },
              { text: "How-to guides", link: "/how-to/install" },
            ],
          },
        ],
      },

      socialLinks: [
        { icon: "github", link: "https://github.com/btravstack/temporal-contract" },
        {
          icon: "npm",
          link: "https://www.npmjs.com/package/@temporal-contract/contract",
        },
      ],

      footer: {
        message: "Released under the MIT License.",
        copyright: `Copyright © ${new Date().getFullYear()} Benoit TRAVERS`,
      },

      search: {
        provider: "local",
      },

      editLink: {
        pattern: "https://github.com/btravstack/temporal-contract/edit/main/docs/:path",
        text: "Edit this page on GitHub",
      },
    },

    head: [
      ["link", { rel: "icon", type: "image/svg+xml", href: `${BASE}logo.svg` }],
      // SEO keywords meta tags
      [
        "meta",
        {
          name: "keywords",
          content:
            "Temporal, Temporal.io, TypeScript, Node.js, workflows, activities, durable execution, type-safe, schema validation, contract-first, type-safe workflows, schema-based workflows, event-driven architecture, microservices, distributed systems",
        },
      ],
      // Open Graph meta tags for better social sharing and SEO
      ["meta", { property: "og:type", content: "website" }],
      ["meta", { property: "og:site_name", content: "temporal-contract" }],
      ["meta", { property: "og:locale", content: "en_US" }],
      [
        "meta",
        {
          property: "og:image",
          content: `${SITE_URL}og-temporal-contract.png`,
        },
      ],
      ["meta", { property: "og:image:type", content: "image/png" }],
      ["meta", { property: "og:image:width", content: "1200" }],
      ["meta", { property: "og:image:height", content: "630" }],
      [
        "meta",
        {
          property: "og:image:alt",
          content: "temporal-contract — type-safe contracts for Temporal.io",
        },
      ],
      // Twitter Card meta tags
      ["meta", { name: "twitter:card", content: "summary_large_image" }],
      [
        "meta",
        {
          name: "twitter:image",
          content: `${SITE_URL}og-temporal-contract.png`,
        },
      ],
      [
        "meta",
        {
          name: "twitter:image:alt",
          content: "temporal-contract — type-safe contracts for Temporal.io",
        },
      ],
      // Additional SEO meta tags
      ["meta", { name: "author", content: "Benoit TRAVERS" }],
      ["meta", { name: "robots", content: "index, follow" }],
      [
        "meta",
        {
          name: "application-name",
          content: "temporal-contract",
        },
      ],
      // JSON-LD structured data for better SEO
      [
        "script",
        { type: "application/ld+json" },
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "temporal-contract",
          description: SITE_DESCRIPTION,
          applicationCategory: "DeveloperApplication",
          operatingSystem: "Cross-platform",
          offers: {
            "@type": "Offer",
            price: "0",
            priceCurrency: "USD",
          },
          url: SITE_URL,
          author: {
            "@type": "Person",
            name: "Benoit TRAVERS",
          },
          programmingLanguage: {
            "@type": "ComputerLanguage",
            name: "TypeScript",
            url: "https://www.typescriptlang.org/",
          },
          keywords:
            "Temporal, Temporal.io, TypeScript, Node.js, workflows, type-safe, schema validation",
        }),
      ],
      // WebSite JSON-LD for proper site name display in Google search
      [
        "script",
        { type: "application/ld+json" },
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "temporal-contract",
          url: SITE_URL,
        }),
      ],
      // Organization JSON-LD for logo display in Google search
      [
        "script",
        { type: "application/ld+json" },
        JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "temporal-contract",
          url: SITE_URL,
          logo: {
            "@type": "ImageObject",
            url: `${SITE_URL}logo.svg`,
          },
          sameAs: ["https://github.com/btravstack/temporal-contract"],
        }),
      ],
    ],
  }),
);
