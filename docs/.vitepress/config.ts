import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const SITE_DESCRIPTION =
  "Build reliable workflow applications with end-to-end type safety, automatic schema validation, and type-safe contracts for Temporal.io workflows and activities in TypeScript";

// https://vitepress.dev/reference/site-config
export default withMermaid(
  defineConfig({
    title: "temporal-contract",
    description: SITE_DESCRIPTION,
    base: "/temporal-contract/",
    lang: "en-US",

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
      hostname: "https://btravstack.github.io/temporal-contract/",
    },

    // Inject canonical URLs and dynamic meta tags for each page to prevent duplicate content issues
    transformPageData(pageData) {
      // Only process markdown files
      if (!pageData.relativePath.endsWith(".md")) {
        return;
      }

      // VitePress provides relativePath without leading slash (e.g., "guide/getting-started.md")
      // Normalize the path by removing any leading slashes just in case
      const normalizedPath = pageData.relativePath.replace(/^\/+/, "");
      const canonicalUrl = `https://btravstack.github.io/temporal-contract/${normalizedPath}`
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
        { text: "Guides", link: "/guide/getting-started" },
        { text: "API", link: "/api/" },
        { text: "Examples", link: "/examples/" },
        { text: "Changelog", link: "https://github.com/btravstack/temporal-contract/releases" },
        // Back to the btravstack hub (links the docs up to the landing page).
        { text: "btravstack", link: "https://btravstack.github.io/" },
      ],

      sidebar: {
        "/guide/": [
          {
            text: "Getting Started",
            items: [
              { text: "Why temporal-contract?", link: "/guide/why-temporal-contract" },
              { text: "Getting Started", link: "/guide/getting-started" },
              { text: "Core Concepts", link: "/guide/core-concepts" },
              { text: "Installation", link: "/guide/installation" },
            ],
          },
          {
            text: "Core Usage",
            items: [
              { text: "Defining Contracts", link: "/guide/defining-contracts" },
              { text: "Client Usage", link: "/guide/client-usage" },
              { text: "Worker Usage", link: "/guide/worker-usage" },
            ],
          },
          {
            text: "Advanced",
            items: [
              { text: "Result Pattern", link: "/guide/result-pattern" },
              { text: "Migrating from @swan-io/boxed", link: "/guide/migrating-to-neverthrow" },
              { text: "Migrating from neverthrow", link: "/guide/migrating-to-unthrown" },
              { text: "Worker Implementation", link: "/guide/worker-implementation" },
              { text: "Entry Points Architecture", link: "/guide/entry-points" },
              { text: "Activity Handler Types", link: "/guide/activity-handlers" },
            ],
          },
          {
            text: "Help",
            items: [{ text: "Troubleshooting", link: "/guide/troubleshooting" }],
          },
        ],
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
        ],
        "/examples/": [
          {
            text: "Examples",
            items: [
              { text: "Overview", link: "/examples/" },
              {
                text: "Basic Order Processing",
                link: "/examples/basic-order-processing",
              },
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
      ["link", { rel: "icon", type: "image/svg+xml", href: "/temporal-contract/logo.svg" }],
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
          content: "https://btravstack.github.io/temporal-contract/og-temporal-contract.png",
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
          content: "https://btravstack.github.io/temporal-contract/og-temporal-contract.png",
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
          url: "https://btravstack.github.io/temporal-contract/",
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
          url: "https://btravstack.github.io/temporal-contract/",
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
          url: "https://btravstack.github.io/temporal-contract/",
          logo: {
            "@type": "ImageObject",
            url: "https://btravstack.github.io/temporal-contract/logo.svg",
          },
          sameAs: ["https://github.com/btravstack/temporal-contract"],
        }),
      ],
    ],
  }),
);
