/**
 * TraceNaut technology & concept registry: the single source of truth for
 *   - what a technology is called and what kind of thing it is,
 *   - how it is drawn (official logo tile, or a TraceNaut conceptual icon),
 *   - how TraceNaut detects it in a repository (evidence signals),
 *   - what TraceNaut can actually do with it (support levels, kept separate).
 *
 * Adding a technology = adding one entry here and running `npm run assets`.
 *
 * Support levels (never inferred from having an icon):
 *   visual   an asset exists                                    (computed)
 *   detect   TraceNaut can tell the repository uses it           (computed from signals)
 *   static   TraceNaut analyses its code structure
 *   runtime  TraceNaut observes it while the app runs
 *   trace    TraceNaut links it to other parts of the system (e.g. request → route → SQL)
 *   explain  a plain-language explanation exists                 (computed)
 */

/** Kinds shown to learners; they distinguish languages, frameworks, runtimes, etc. */
export const KINDS = ['language', 'library', 'framework', 'runtime', 'protocol', 'data-format', 'database', 'browser-api', 'tool', 'platform', 'service'];

export const CATEGORIES = {
  language: 'Programming languages',
  frontend: 'Frontend',
  backend: 'Backend',
  data: 'Databases & data access',
  infra: 'Infrastructure & delivery',
  tooling: 'Development tools',
  auth: 'Authentication',
  messaging: 'Messaging & real time',
  testing: 'Testing',
};

const T = (id, name, category, kind, opts) => ({ id, name, category, kind, logo: null, icon: null, signals: {}, support: {}, ...opts });

// Signals: npm (package names; prefix match when ending with '/'), ext (file extensions),
// files (file names or path globs relative to any folder), py (Python requirement names),
// manifest (presence of another ecosystem's manifest file).
export const TECHNOLOGIES = [
  // ---------------------------------------------------------------- languages
  T('javascript', 'JavaScript', 'language', 'language', {
    logo: 'javascript',
    signals: { ext: ['.js', '.mjs', '.cjs', '.jsx'] },
    support: { static: true, runtime: true, trace: true },
    what: 'The programming language of the web. Browsers run it, and Node.js runs it on servers.',
    effect: 'Code written in it can react to clicks, change the page and talk to servers.',
  }),
  T('typescript', 'TypeScript', 'language', 'language', {
    logo: 'typescript',
    signals: { ext: ['.ts', '.mts', '.cts'], npm: ['typescript'], files: ['tsconfig.json'] },
    support: { static: true, runtime: true, trace: true },
    what: 'JavaScript with types added, so mistakes are caught before the code runs.',
    effect: 'A build step removes the types; at runtime it behaves exactly like JavaScript.',
  }),
  T('tsx', 'TSX', 'language', 'language', {
    logo: 'typescript',
    signals: { ext: ['.tsx'] },
    support: { static: true, runtime: true, trace: true },
    what: 'TypeScript that also contains JSX: HTML-like tags describing the interface.',
    effect: 'The tags are turned into calls that draw the page (usually with React).',
  }),
  T('python', 'Python', 'language', 'language', { logo: 'python', signals: { ext: ['.py'], manifest: ['requirements.txt', 'pyproject.toml', 'Pipfile'] }, what: 'A general-purpose language known for readable code, popular for web backends, data and AI.', effect: 'Its code runs on the server (or a script), not in the browser.' }),
  T('java', 'Java', 'language', 'language', { icon: 'language', signals: { ext: ['.java'], manifest: ['pom.xml', 'build.gradle'] }, what: 'A long-established, typed language used for large backend systems and Android apps.', effect: 'Its code is compiled and runs on the Java Virtual Machine.' }),
  T('kotlin', 'Kotlin', 'language', 'language', { logo: 'kotlin', signals: { ext: ['.kt', '.kts'] }, what: 'A modern language for the Java platform and Android.', effect: 'Its code runs on the Java Virtual Machine or on Android.' }),
  T('c', 'C', 'language', 'language', { logo: 'c', signals: { ext: ['.c', '.h'] }, what: 'A low-level language close to the hardware, used for systems and performance-critical code.', effect: 'It is compiled to machine code that runs directly on the processor.' }),
  T('cpp', 'C++', 'language', 'language', { logo: 'cplusplus', signals: { ext: ['.cpp', '.cc', '.hpp', '.cxx'] }, what: 'C extended with classes and templates, used for games, browsers and high-performance software.', effect: 'It is compiled to machine code that runs directly on the processor.' }),
  T('csharp', 'C#', 'language', 'language', { icon: 'language', signals: { ext: ['.cs'], manifest: ['*.csproj'] }, what: 'A typed language from Microsoft for .NET applications and games (Unity).', effect: 'Its code runs on the .NET runtime.' }),
  T('go', 'Go', 'language', 'language', { logo: 'go', signals: { ext: ['.go'], manifest: ['go.mod'] }, what: 'A simple, fast compiled language popular for servers and command-line tools.', effect: 'It compiles to a single program that runs on the server.' }),
  T('rust', 'Rust', 'language', 'language', { logo: 'rust', signals: { ext: ['.rs'], manifest: ['Cargo.toml'] }, what: 'A fast, memory-safe systems language.', effect: 'It compiles to machine code, or to WebAssembly for the browser.' }),
  T('ruby', 'Ruby', 'language', 'language', { logo: 'ruby', signals: { ext: ['.rb'], manifest: ['Gemfile'] }, what: 'A dynamic language focused on developer happiness, known for Ruby on Rails.', effect: 'Its code runs on the server.' }),
  T('php', 'PHP', 'language', 'language', { logo: 'php', signals: { ext: ['.php'], manifest: ['composer.json'] }, what: 'A server-side language that powers many websites, including WordPress and Laravel apps.', effect: 'The server runs it to build each page or API answer.' }),
  T('swift', 'Swift', 'language', 'language', { logo: 'swift', signals: { ext: ['.swift'], manifest: ['Package.swift'] }, what: "Apple's language for iOS and macOS apps.", effect: 'It compiles to apps that run on Apple devices.' }),
  T('dart', 'Dart', 'language', 'language', { logo: 'dart', signals: { ext: ['.dart'], manifest: ['pubspec.yaml'] }, what: 'The language behind Flutter apps.', effect: 'It compiles to mobile, desktop or web apps.' }),
  T('html', 'HTML', 'language', 'language', { logo: 'html5', signals: { ext: ['.html', '.htm'] }, what: 'The markup language that describes the structure of web pages.', effect: 'The browser turns it into the elements you see.' }),
  T('css', 'CSS', 'language', 'language', { logo: 'css', signals: { ext: ['.css'] }, what: 'The language that describes how web pages look: colours, layout, fonts.', effect: 'The browser applies it to the page elements.' }),
  T('sass', 'Sass', 'language', 'language', { icon: 'language', signals: { ext: ['.scss', '.sass'], npm: ['sass'] }, what: 'CSS with variables, nesting and functions; compiled to plain CSS.', effect: 'A build step turns it into CSS for the browser.' }),
  T('sql', 'SQL', 'language', 'language', {
    icon: 'query',
    signals: { ext: ['.sql'] },
    support: { static: true, runtime: true, trace: true },
    what: 'A language for asking a database questions and changing its data.',
    effect: 'The database runs it and returns rows or changes stored data.',
  }),
  T('graphql', 'GraphQL', 'language', 'protocol', { logo: 'graphql', signals: { npm: ['graphql'], ext: ['.graphql', '.gql'] }, what: 'A query language for APIs: the client asks for exactly the fields it needs.', effect: 'Requests usually go to a single endpoint, and the server resolves each field.' }),
  T('bash', 'Bash', 'language', 'language', { logo: 'gnubash', signals: { ext: ['.sh', '.bash'] }, what: 'The shell language for scripts that run commands.', effect: 'Scripts automate tasks such as building or deploying.' }),
  T('scala', 'Scala', 'language', 'language', { logo: 'scala', signals: { ext: ['.scala'] }, what: 'A language for the Java platform mixing objects and functional programming.', effect: 'Its code runs on the Java Virtual Machine.' }),
  T('elixir', 'Elixir', 'language', 'language', { logo: 'elixir', signals: { ext: ['.ex', '.exs'], manifest: ['mix.exs'] }, what: 'A functional language built for reliable, concurrent systems.', effect: 'Its code runs on the Erlang virtual machine.' }),
  T('lua', 'Lua', 'language', 'language', { logo: 'lua', signals: { ext: ['.lua'] }, what: 'A small scripting language often embedded in other programs.', effect: 'A host program runs its scripts.' }),
  T('r', 'R', 'language', 'language', { logo: 'r', signals: { ext: ['.r', '.R'] }, what: 'A language for statistics and data analysis.', effect: 'Its scripts compute results and charts from data.' }),
  T('zig', 'Zig', 'language', 'language', { logo: 'zig', signals: { ext: ['.zig'] }, what: 'A low-level systems language designed as a simpler alternative to C.', effect: 'It compiles to machine code.' }),
  T('wasm', 'WebAssembly', 'language', 'language', { logo: 'webassembly', signals: { ext: ['.wasm', '.wat'] }, what: 'A compact binary format that lets code from languages like Rust or C run in the browser.', effect: 'The browser runs it at near-native speed alongside JavaScript.' }),

  // ---------------------------------------------------------------- frontend
  T('react', 'React', 'frontend', 'library', {
    logo: 'react',
    signals: { npm: ['react', 'react-dom'] },
    support: { static: true, runtime: true, trace: true },
    what: 'A library for building interfaces out of components.',
    effect: 'When data changes, React redraws the parts of the page that depend on it.',
  }),
  T('nextjs', 'Next.js', 'frontend', 'framework', {
    logo: 'nextdotjs',
    signals: { npm: ['next'], files: ['next.config.js', 'next.config.mjs', 'next.config.ts'] },
    // static/trace: route files, pages, Server Actions. runtime: @tracenaut/next + the Node agent,
    // validated on two real apps (Next 15.5 and 16.4, Turbopack).
    support: { static: true, runtime: true, trace: true },
    what: 'A React framework with file-based routing, server rendering and API routes.',
    effect: 'Files in app/ or pages/ become pages and API endpoints automatically.',
  }),
  T('vue', 'Vue', 'frontend', 'framework', { icon: 'framework', signals: { npm: ['vue'], ext: ['.vue'] }, what: 'A framework for building interfaces with templates and reactive data.', effect: 'When data changes, Vue updates the template on the page.' }),
  T('nuxt', 'Nuxt', 'frontend', 'framework', { logo: 'nuxt', signals: { npm: ['nuxt'], files: ['nuxt.config.ts', 'nuxt.config.js'] }, what: 'A Vue framework with file-based routing and server rendering.', effect: 'Files become pages and server endpoints automatically.' }),
  T('angular', 'Angular', 'frontend', 'framework', { logo: 'angular', signals: { npm: ['@angular/core'], files: ['angular.json'] }, what: "Google's full framework for large web applications.", effect: 'Components, services and routing are wired together by the framework.' }),
  T('svelte', 'Svelte', 'frontend', 'framework', { logo: 'svelte', signals: { npm: ['svelte', '@sveltejs/kit'], ext: ['.svelte'] }, what: 'A framework that compiles components into small, efficient JavaScript.', effect: 'Updates are compiled in ahead of time instead of computed at runtime.' }),
  T('solid', 'Solid', 'frontend', 'library', { logo: 'solid', signals: { npm: ['solid-js'] }, what: 'A UI library with fine-grained reactivity.', effect: 'Only the exact pieces of the page that depend on changed data update.' }),
  T('preact', 'Preact', 'frontend', 'library', { logo: 'preact', signals: { npm: ['preact'] }, what: 'A tiny alternative to React with the same API.', effect: 'Components redraw when their data changes, like React.' }),
  T('astro', 'Astro', 'frontend', 'framework', { logo: 'astro', signals: { npm: ['astro'], ext: ['.astro'] }, what: 'A framework for content sites that ships little JavaScript.', effect: 'Pages are mostly built ahead of time as HTML.' }),
  T('remix', 'React Router / Remix', 'frontend', 'framework', { logo: 'reactrouter', signals: { npm: ['react-router', 'react-router-dom', '@remix-run/'] }, what: 'Routing for React apps: maps addresses to screens, and can load data per route.', effect: 'Changing the address shows a different screen without reloading the page.' }),
  T('vite', 'Vite', 'tooling', 'tool', {
    logo: 'vite',
    signals: { npm: ['vite'], files: ['vite.config.ts', 'vite.config.js', 'vite.config.mjs'] },
    support: { runtime: true },
    what: 'A fast development server and build tool for web apps.',
    effect: 'It serves your code to the browser during development and bundles it for production.',
  }),
  T('webpack', 'webpack', 'tooling', 'tool', { logo: 'webpack', signals: { npm: ['webpack'], files: ['webpack.config.js'] }, what: 'A bundler that packs many code files into a few for the browser.', effect: 'The browser downloads the bundles instead of every source file.' }),
  T('babel', 'Babel', 'tooling', 'tool', { logo: 'babel', signals: { npm: ['@babel/core'], files: ['babel.config.js', '.babelrc'] }, what: 'A compiler that rewrites modern JavaScript and JSX into code browsers understand.', effect: 'Source code is transformed before it runs.' }),
  T('tailwind', 'Tailwind CSS', 'frontend', 'framework', { logo: 'tailwindcss', signals: { npm: ['tailwindcss', '@tailwindcss/'], files: ['tailwind.config.js', 'tailwind.config.ts'] }, what: 'A CSS framework of small utility classes used directly in the markup.', effect: 'Elements get their look from class names such as "p-4" or "text-sm".' }),
  T('bootstrap', 'Bootstrap', 'frontend', 'framework', { logo: 'bootstrap', signals: { npm: ['bootstrap'] }, what: 'A CSS framework with ready-made layout and components.', effect: 'Pages use its classes to get a consistent look.' }),
  T('mui', 'MUI', 'frontend', 'library', { logo: 'mui', signals: { npm: ['@mui/material'] }, what: 'A library of ready-made React components following Material Design.', effect: 'Buttons, dialogs and forms come pre-built and styled.' }),
  T('redux', 'Redux', 'frontend', 'library', { logo: 'redux', signals: { npm: ['redux', '@reduxjs/toolkit'] }, what: 'A library that keeps app-wide state in one store, changed by actions.', effect: 'Components read from the store and redraw when it changes.' }),
  T('axios', 'axios', 'frontend', 'library', {
    icon: 'library',
    signals: { npm: ['axios'] },
    support: { static: true, trace: true },
    what: 'A popular library for sending HTTP requests from the browser or Node.js.',
    effect: 'Calls such as axios.get("/api/items") send requests; JSON answers are decoded automatically.',
  }),
  T('tanstack-query', 'TanStack Query', 'frontend', 'library', { logo: 'reactquery', signals: { npm: ['@tanstack/react-query', 'react-query'] }, support: { static: true, trace: true }, what: 'A library that fetches, caches and refreshes server data in React apps.', effect: 'Screens show cached data and re-fetch it in the background.' }),
  T('jquery', 'jQuery', 'frontend', 'library', { logo: 'jquery', signals: { npm: ['jquery'] }, what: 'A classic library that simplifies changing the page and sending requests.', effect: 'Code selects elements with $(…) and changes them directly.' }),
  T('threejs', 'Three.js', 'frontend', 'library', { logo: 'threedotjs', signals: { npm: ['three'] }, what: 'A library for 3D graphics in the browser.', effect: 'Scenes are drawn with WebGL inside a canvas.' }),
  T('d3', 'D3', 'frontend', 'library', { icon: 'library', signals: { npm: ['d3'] }, what: 'A library for data-driven charts and visualisations.', effect: 'Data is bound to SVG or canvas shapes on the page.' }),
  T('i18next', 'i18next', 'frontend', 'library', { icon: 'library', signals: { npm: ['i18next', 'react-i18next'] }, what: 'A library for translating an interface into several languages.', effect: 'Text is looked up by key in the user’s language.' }),

  // ---------------------------------------------------------------- backend & runtimes
  T('nodejs', 'Node.js', 'backend', 'runtime', {
    logo: 'nodedotjs',
    signals: { manifest: ['package.json'] },
    support: { static: true, runtime: true, trace: true },
    what: 'A program that runs JavaScript outside the browser, typically on a server.',
    effect: 'It can listen for network requests, read files and talk to databases.',
  }),
  T('bun', 'Bun', 'backend', 'runtime', { logo: 'bun', signals: { files: ['bun.lockb', 'bun.lock', 'bunfig.toml'] }, what: 'A fast JavaScript runtime, package manager and bundler in one.', effect: 'It runs the server code instead of Node.js.' }),
  T('deno', 'Deno', 'backend', 'runtime', { logo: 'deno', signals: { files: ['deno.json', 'deno.jsonc'] }, what: 'A secure JavaScript and TypeScript runtime.', effect: 'It runs the server code with explicit permissions.' }),
  T('express', 'Express', 'backend', 'framework', {
    logo: 'express',
    signals: { npm: ['express'] },
    support: { static: true, runtime: true, trace: true },
    what: 'A framework for building web servers on Node.js.',
    effect: 'It receives HTTP requests and sends each one to the code registered for its address (a route).',
  }),
  T('fastify', 'Fastify', 'backend', 'framework', { logo: 'fastify', signals: { npm: ['fastify'] }, support: { static: true, runtime: true, trace: true }, what: 'A fast web framework for Node.js.', effect: 'It routes each HTTP request to a handler function.' }),
  T('koa', 'Koa', 'backend', 'framework', { logo: 'koa', signals: { npm: ['koa', '@koa/router', 'koa-router'] }, support: { static: true, runtime: true, trace: true }, what: 'A minimal web framework for Node.js built around middleware.', effect: 'Each request passes through a chain of middleware functions.' }),
  T('hono', 'Hono', 'backend', 'framework', { logo: 'hono', signals: { npm: ['hono'] }, support: { static: true, runtime: true, trace: true }, what: 'A small web framework that runs on many JavaScript runtimes.', effect: 'It routes each HTTP request to a handler function.' }),
  T('nestjs', 'NestJS', 'backend', 'framework', { logo: 'nestjs', signals: { npm: ['@nestjs/core'] }, what: 'A structured Node.js framework using classes, modules and decorators.', effect: 'Controllers receive requests and call services.' }),
  T('trpc', 'tRPC', 'backend', 'library', { logo: 'trpc', signals: { npm: ['@trpc/server'] }, what: 'A way to call server functions from the browser with shared TypeScript types.', effect: 'Calls look like local functions but travel over HTTP.' }),
  T('apollo', 'Apollo GraphQL', 'backend', 'library', { logo: 'apollographql', signals: { npm: ['@apollo/server', 'apollo-server', '@apollo/client'] }, what: 'Libraries for building and calling GraphQL APIs.', effect: 'Queries are resolved field by field on the server.' }),
  T('socketio', 'Socket.IO', 'messaging', 'library', { logo: 'socketdotio', signals: { npm: ['socket.io', 'socket.io-client'] }, what: 'A library for real-time, two-way communication between browser and server.', effect: 'The server can push updates to the page at any time.' }),
  T('websocket', 'WebSocket', 'messaging', 'protocol', { icon: 'protocol', signals: { npm: ['ws'] }, support: { runtime: true }, what: 'A protocol for a long-lived, two-way connection between browser and server.', effect: 'Either side can send messages at any time, without new HTTP requests.' }),
  T('fastapi', 'FastAPI', 'backend', 'framework', { logo: 'fastapi', signals: { py: ['fastapi'] }, what: 'A modern Python framework for building APIs.', effect: 'Python functions answer HTTP requests, with data validated by type hints.' }),
  T('django', 'Django', 'backend', 'framework', { logo: 'django', signals: { py: ['django'], files: ['manage.py'] }, what: 'A full Python web framework with an ORM, admin and templates.', effect: 'URLs map to views that query the database and render pages.' }),
  T('flask', 'Flask', 'backend', 'framework', { logo: 'flask', signals: { py: ['flask'] }, what: 'A lightweight Python web framework.', effect: 'Decorated Python functions answer requests for each URL.' }),
  T('spring', 'Spring Boot', 'backend', 'framework', { logo: 'springboot', signals: { files: ['pom.xml', 'build.gradle'], text: { 'pom.xml': 'spring-boot', 'build.gradle': 'spring-boot' } }, what: 'A Java framework for building production-ready services.', effect: 'Annotated classes become HTTP controllers, services and repositories.' }),
  T('laravel', 'Laravel', 'backend', 'framework', { logo: 'laravel', signals: { files: ['artisan'], text: { 'composer.json': 'laravel/framework' } }, what: 'A PHP framework with routing, an ORM and templates.', effect: 'Routes send requests to controllers that use the database.' }),
  T('rails', 'Ruby on Rails', 'backend', 'framework', { logo: 'rubyonrails', signals: { text: { Gemfile: "'rails'" } }, what: 'A Ruby framework that favours convention over configuration.', effect: 'Routes map to controllers; models map to database tables.' }),
  T('aspnet', 'ASP.NET', 'backend', 'framework', { logo: 'dotnet', signals: { manifest: ['*.csproj'] }, what: "Microsoft's framework for web apps and APIs on .NET.", effect: 'Controllers or minimal APIs answer HTTP requests.' }),

  // ---------------------------------------------------------------- data
  T('sqlite', 'SQLite', 'data', 'database', {
    logo: 'sqlite',
    signals: { npm: ['better-sqlite3', 'sqlite3', '@libsql/client'], imports: ['node:sqlite'], ext: ['.db', '.sqlite', '.sqlite3'] },
    support: { static: true, runtime: true, trace: true },
    what: 'A small database stored in a single file, used directly by the app.',
    effect: 'The app reads and writes rows in a local file, with no separate database server.',
  }),
  T('postgresql', 'PostgreSQL', 'data', 'database', {
    logo: 'postgresql',
    signals: { npm: ['pg', 'postgres', '@neondatabase/serverless'], py: ['psycopg2', 'psycopg', 'asyncpg'], text: { 'schema.prisma': 'provider = "postgresql"' } },
    support: { static: true, runtime: true },
    what: 'A powerful open-source relational database server.',
    effect: 'The app sends SQL to a database server, which stores and returns rows.',
  }),
  T('mysql', 'MySQL', 'data', 'database', { logo: 'mysql', signals: { npm: ['mysql', 'mysql2'], py: ['pymysql', 'mysqlclient'] }, support: { static: true }, what: 'A widely used open-source relational database server.', effect: 'The app sends SQL to a database server, which stores and returns rows.' }),
  T('mariadb', 'MariaDB', 'data', 'database', { logo: 'mariadb', signals: { npm: ['mariadb'] }, what: 'A community-developed relational database compatible with MySQL.', effect: 'The app sends SQL to a database server, which stores and returns rows.' }),
  T('mongodb', 'MongoDB', 'data', 'database', { logo: 'mongodb', signals: { npm: ['mongodb', 'mongoose'], py: ['pymongo', 'motor'] }, what: 'A document database that stores JSON-like records instead of table rows.', effect: 'The app saves and finds documents in collections.' }),
  T('redis', 'Redis', 'data', 'database', { logo: 'redis', signals: { npm: ['redis', 'ioredis'], py: ['redis'] }, what: 'An in-memory data store, often used as a cache, session store or queue.', effect: 'Data the app needs often is served from memory instead of the main database.' }),
  T('firebase', 'Firebase', 'data', 'platform', { logo: 'firebase', signals: { npm: ['firebase', 'firebase-admin'] }, what: "Google's platform with a hosted database, authentication and hosting.", effect: 'The app reads and writes data in Google’s cloud directly from the client or server.' }),
  T('supabase', 'Supabase', 'data', 'platform', { logo: 'supabase', signals: { npm: ['@supabase/supabase-js'] }, what: 'A hosted backend built on PostgreSQL, with auth and storage.', effect: 'The app talks to a hosted Postgres database through an API.' }),
  T('dynamodb', 'DynamoDB', 'data', 'database', { icon: 'database', signals: { npm: ['@aws-sdk/client-dynamodb', '@aws-sdk/lib-dynamodb'] }, what: 'Amazon’s hosted key-value and document database.', effect: 'The app stores and fetches items by key in AWS.' }),
  T('elasticsearch', 'Elasticsearch', 'data', 'database', { logo: 'elasticsearch', signals: { npm: ['@elastic/elasticsearch'] }, what: 'A search engine that indexes documents for fast full-text search.', effect: 'Search queries return matching documents ranked by relevance.' }),
  T('cassandra', 'Apache Cassandra', 'data', 'database', { logo: 'apachecassandra', signals: { npm: ['cassandra-driver'] }, what: 'A distributed database built for very large, always-available workloads.', effect: 'Data is spread across many servers.' }),
  T('neo4j', 'Neo4j', 'data', 'database', { logo: 'neo4j', signals: { npm: ['neo4j-driver'] }, what: 'A graph database that stores data as nodes and relationships.', effect: 'Queries follow relationships between records.' }),
  T('prisma', 'Prisma', 'data', 'library', {
    logo: 'prisma',
    signals: { npm: ['@prisma/client', 'prisma'], files: ['schema.prisma'] },
    // Model calls are matched against the schema; the SQL Prisma generates is not shown statically.
    // runtime: its SQL is observed when it uses a JavaScript driver adapter (validated with
    // @prisma/adapter-pg in Prisma 7); the older native engine is invisible to the agent.
    support: { static: true, runtime: true, trace: true },
    what: 'An ORM: TypeScript code that reads and writes the database without writing SQL by hand.',
    effect: 'Calls like prisma.user.findUnique() become SQL queries.',
  }),
  T('drizzle', 'Drizzle ORM', 'data', 'library', { logo: 'drizzle', signals: { npm: ['drizzle-orm'] }, support: { runtime: true }, what: 'A lightweight TypeScript ORM that stays close to SQL.', effect: 'Typed query builders become SQL queries.' }),
  T('sequelize', 'Sequelize', 'data', 'library', { logo: 'sequelize', signals: { npm: ['sequelize'] }, what: 'An ORM for Node.js that maps classes to database tables.', effect: 'Model methods become SQL queries.' }),
  T('mongoose', 'Mongoose', 'data', 'library', { logo: 'mongoose', signals: { npm: ['mongoose'] }, support: { static: true }, what: 'A library that defines schemas and models for MongoDB.', effect: 'Model methods like User.find() query MongoDB.' }),
  T('typeorm', 'TypeORM', 'data', 'library', { logo: 'typeorm', signals: { npm: ['typeorm'] }, what: 'An ORM for TypeScript using decorated entity classes.', effect: 'Repository methods become SQL queries.' }),
  T('knex', 'Knex.js', 'data', 'library', { logo: 'knexdotjs', signals: { npm: ['knex'] }, what: 'A SQL query builder for Node.js.', effect: 'Chained calls build SQL queries.' }),

  // ---------------------------------------------------------------- infrastructure & delivery
  T('docker', 'Docker', 'infra', 'platform', { logo: 'docker', signals: { files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'] }, what: 'A tool that packages an app and everything it needs into a container.', effect: 'The app runs the same way on any machine that runs the container.' }),
  T('kubernetes', 'Kubernetes', 'infra', 'platform', { logo: 'kubernetes', signals: { files: ['k8s/', 'kubernetes/', 'helm/', 'Chart.yaml', 'kustomization.yaml'] }, what: 'A system that runs and scales containers across many machines.', effect: 'It keeps the right number of copies of each service running.' }),
  T('nginx', 'NGINX', 'infra', 'service', { logo: 'nginx', signals: { files: ['nginx.conf', 'nginx/'] }, what: 'A web server often used as a reverse proxy in front of apps.', effect: 'It forwards incoming requests to the right app and serves static files.' }),
  T('traefik', 'Traefik', 'infra', 'service', { logo: 'traefikproxy', signals: { files: ['traefik.yml', 'traefik.toml'] }, what: 'A reverse proxy that routes traffic to containers automatically.', effect: 'Incoming requests are forwarded to the matching service.' }),
  T('kong', 'Kong Gateway', 'infra', 'service', { logo: 'kong', signals: { files: ['kong.yml', 'kong.yaml'] }, what: 'An API gateway that sits in front of services.', effect: 'Requests pass through it for routing, auth and rate limiting.' }),
  T('github-actions', 'GitHub Actions', 'infra', 'service', { logo: 'githubactions', signals: { files: ['.github/workflows/'] }, what: 'GitHub’s automation for building, testing and deploying code.', effect: 'Workflows run automatically when code is pushed.' }),
  T('gitlab-ci', 'GitLab CI', 'infra', 'service', { logo: 'gitlab', signals: { files: ['.gitlab-ci.yml'] }, what: 'GitLab’s automation for building, testing and deploying code.', effect: 'Pipelines run automatically when code is pushed.' }),
  T('circleci', 'CircleCI', 'infra', 'service', { logo: 'circleci', signals: { files: ['.circleci/'] }, what: 'A hosted service that builds and tests code automatically.', effect: 'Pipelines run when code is pushed.' }),
  T('jenkins', 'Jenkins', 'infra', 'service', { logo: 'jenkins', signals: { files: ['Jenkinsfile'] }, what: 'A self-hosted automation server for builds and deployments.', effect: 'Jobs run builds and tests on a schedule or on change.' }),
  T('terraform', 'Terraform', 'infra', 'tool', { logo: 'terraform', signals: { ext: ['.tf'] }, what: 'A tool that describes cloud infrastructure as code.', effect: 'Servers, databases and networks are created from configuration files.' }),
  T('vercel', 'Vercel', 'infra', 'platform', { logo: 'vercel', signals: { files: ['vercel.json', 'vercel.ts', '.vercel/'] }, what: 'A cloud platform for deploying web apps and serverless functions.', effect: 'Each push can be deployed to a public URL automatically.' }),
  T('netlify', 'Netlify', 'infra', 'platform', { logo: 'netlify', signals: { files: ['netlify.toml'] }, what: 'A cloud platform for deploying web sites and functions.', effect: 'Each push can be built and published automatically.' }),
  T('cloudflare', 'Cloudflare', 'infra', 'platform', { logo: 'cloudflare', signals: { files: ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'] }, what: 'A network platform for caching, security and running code at the edge.', effect: 'Code and content are served from locations close to users.' }),
  T('aws', 'AWS', 'infra', 'platform', { icon: 'cloud', signals: { npm: ['@aws-sdk/'], files: ['serverless.yml', 'template.yaml', 'cdk.json'] }, what: 'Amazon Web Services: a large collection of cloud services.', effect: 'The app uses hosted servers, storage or databases in Amazon’s cloud.' }),
  T('azure', 'Microsoft Azure', 'infra', 'platform', { icon: 'cloud', signals: { npm: ['@azure/'] }, what: 'Microsoft’s cloud platform.', effect: 'The app uses hosted services in Microsoft’s cloud.' }),
  T('gcp', 'Google Cloud', 'infra', 'platform', { logo: 'googlecloud', signals: { npm: ['@google-cloud/'], files: ['app.yaml', 'cloudbuild.yaml'] }, what: 'Google’s cloud platform.', effect: 'The app uses hosted services in Google’s cloud.' }),
  T('rabbitmq', 'RabbitMQ', 'messaging', 'service', { logo: 'rabbitmq', signals: { npm: ['amqplib'] }, what: 'A message broker that passes messages between services through queues.', effect: 'Work is queued and handled later by another process.' }),
  T('kafka', 'Apache Kafka', 'messaging', 'service', { logo: 'apachekafka', signals: { npm: ['kafkajs'] }, what: 'A distributed log for streaming events between services.', effect: 'Services publish events and others react to them.' }),
  T('bullmq', 'BullMQ', 'messaging', 'library', { icon: 'queue', signals: { npm: ['bullmq', 'bull'] }, what: 'A job queue for Node.js backed by Redis.', effect: 'Slow work runs in the background instead of during the request.' }),

  // ---------------------------------------------------------------- authentication
  T('jwt', 'JSON Web Tokens', 'auth', 'data-format', { logo: 'jsonwebtokens', signals: { npm: ['jsonwebtoken', 'jose'] }, what: 'Signed tokens that prove who a user is.', effect: 'The browser sends the token with each request; the server checks its signature.' }),
  T('passport', 'Passport', 'auth', 'library', { logo: 'passport', signals: { npm: ['passport'] }, what: 'Authentication middleware for Node.js with many login strategies.', effect: 'Requests are checked for a logged-in user before reaching routes.' }),
  T('auth0', 'Auth0', 'auth', 'service', { logo: 'auth0', signals: { npm: ['@auth0/'] }, what: 'A hosted login and identity service.', effect: 'Users sign in on Auth0, which tells the app who they are.' }),
  T('clerk', 'Clerk', 'auth', 'service', { logo: 'clerk', signals: { npm: ['@clerk/'] }, what: 'A hosted service for sign-in and user management.', effect: 'Sign-in screens and sessions are handled by Clerk.' }),
  T('nextauth', 'Auth.js', 'auth', 'library', { icon: 'auth', signals: { npm: ['next-auth', '@auth/core'] }, what: 'An authentication library for Next.js and other frameworks.', effect: 'It manages sign-in providers and sessions.' }),
  T('keycloak', 'Keycloak', 'auth', 'service', { logo: 'keycloak', signals: { npm: ['keycloak-js', 'keycloak-connect'] }, what: 'An open-source identity and access management server.', effect: 'Users sign in through Keycloak, which issues tokens to the app.' }),
  T('bcrypt', 'bcrypt', 'auth', 'library', { icon: 'lock', signals: { npm: ['bcrypt', 'bcryptjs'] }, what: 'A password-hashing algorithm.', effect: 'Passwords are stored as hashes, never as plain text.' }),

  // ---------------------------------------------------------------- tools & testing
  T('git', 'Git', 'tooling', 'tool', { logo: 'git', signals: { files: ['.gitignore'] }, what: 'A version-control system that records every change to the code.', effect: 'Developers can review history, branch and merge changes.' }),
  T('github', 'GitHub', 'tooling', 'platform', { logo: 'github', signals: { files: ['.github/'] }, what: 'A platform for hosting Git repositories and collaborating on code.', effect: 'Code, issues and reviews live in one place.' }),
  T('npm', 'npm', 'tooling', 'tool', { logo: 'npm', signals: { files: ['package-lock.json'] }, what: 'The package manager for JavaScript.', effect: 'It installs the libraries listed in package.json.' }),
  T('pnpm', 'pnpm', 'tooling', 'tool', { logo: 'pnpm', signals: { files: ['pnpm-lock.yaml'] }, what: 'A fast, disk-efficient JavaScript package manager.', effect: 'It installs the libraries listed in package.json.' }),
  T('yarn', 'Yarn', 'tooling', 'tool', { logo: 'yarn', signals: { files: ['yarn.lock'] }, what: 'A JavaScript package manager.', effect: 'It installs the libraries listed in package.json.' }),
  T('eslint', 'ESLint', 'tooling', 'tool', { logo: 'eslint', signals: { npm: ['eslint'] }, what: 'A tool that checks JavaScript code for mistakes and style issues.', effect: 'Problems are reported before the code runs.' }),
  T('prettier', 'Prettier', 'tooling', 'tool', { logo: 'prettier', signals: { npm: ['prettier'] }, what: 'A tool that formats code automatically.', effect: 'Code keeps a consistent style.' }),
  T('jest', 'Jest', 'testing', 'tool', { logo: 'jest', signals: { npm: ['jest'] }, what: 'A JavaScript testing framework.', effect: 'Automated tests check that code still works.' }),
  T('vitest', 'Vitest', 'testing', 'tool', { logo: 'vitest', signals: { npm: ['vitest'] }, what: 'A fast testing framework built on Vite.', effect: 'Automated tests check that code still works.' }),
  T('playwright', 'Playwright', 'testing', 'tool', { icon: 'test', signals: { npm: ['@playwright/test', 'playwright'] }, what: 'A tool that drives real browsers to test web apps end to end.', effect: 'Tests click through the app like a user would.' }),
  T('cypress', 'Cypress', 'testing', 'tool', { logo: 'cypress', signals: { npm: ['cypress'] }, what: 'A tool for end-to-end testing of web apps in a browser.', effect: 'Tests click through the app like a user would.' }),
  T('storybook', 'Storybook', 'testing', 'tool', { logo: 'storybook', signals: { npm: ['storybook', '@storybook/'] }, what: 'A workshop for building and viewing UI components in isolation.', effect: 'Each component can be developed and reviewed on its own.' }),
  T('openapi', 'OpenAPI', 'tooling', 'data-format', { logo: 'openapiinitiative', signals: { files: ['openapi.yaml', 'openapi.json', 'swagger.yaml', 'swagger.json'] }, what: 'A standard format for describing HTTP APIs.', effect: 'Tools can generate documentation and clients from the description.' }),
  T('sentry', 'Sentry', 'tooling', 'service', { logo: 'sentry', signals: { npm: ['@sentry/'] }, what: 'A service that collects errors and performance data from apps.', effect: 'Crashes in production are reported to developers.' }),
  T('prometheus', 'Prometheus', 'infra', 'service', { logo: 'prometheus', signals: { npm: ['prom-client'], files: ['prometheus.yml'] }, what: 'A monitoring system that collects numeric metrics over time.', effect: 'Dashboards and alerts show how the system behaves.' }),
  T('grafana', 'Grafana', 'infra', 'service', { logo: 'grafana', signals: { files: ['grafana/'] }, what: 'A dashboard tool for visualising metrics and logs.', effect: 'Charts show how the system behaves over time.' }),
];

/**
 * TraceNaut's own conceptual icons (drawn by scripts/icons/build-icons.mjs). Used for
 * software concepts, architectural ideas, certainty, and as fallbacks for technologies
 * without a usable official logo.
 */
export const CONCEPT_ICONS = {
  // places & architecture
  browser: 'Browser / frontend',
  server: 'Server / backend',
  database: 'Database',
  network: 'Network communication',
  api: 'Browser feature / API',
  cloud: 'Cloud platform',
  gateway: 'API gateway / proxy',
  microservices: 'Microservices',
  'event-bus': 'Event-driven communication',
  storage: 'File / object storage',
  container: 'Container',
  queue: 'Message queue',
  cache: 'Cache',
  // code & runtime concepts
  code: 'Code (generic)',
  'code-browser': 'Code running in the browser',
  'code-server': 'Code running on the server',
  component: 'Component',
  hook: 'Hook',
  class: 'Class',
  object: 'Object',
  state: 'State',
  event: 'Event',
  interaction: 'User interaction',
  update: 'Page update / re-render',
  request: 'Request',
  response: 'Response',
  route: 'Route',
  middleware: 'Middleware',
  async: 'Asynchronous operation / promise',
  loop: 'Loop',
  condition: 'Condition',
  branch: 'Execution path / branching',
  error: 'Error / exception',
  transform: 'Data transformation',
  query: 'Database query',
  transaction: 'Transaction',
  // security
  auth: 'Authentication',
  lock: 'Authorization / protected',
  session: 'Session',
  token: 'Token',
  user: 'User',
  // tech kinds & fallbacks
  language: 'Programming language (generic)',
  library: 'Library (generic)',
  framework: 'Framework (generic)',
  runtime: 'Runtime (generic)',
  protocol: 'Protocol',
  data: 'Data format',
  tool: 'Development tool',
  test: 'Testing',
  package: 'Package',
  file: 'File',
  config: 'Configuration',
  // certainty & outcomes
  ok: 'Happened (observed)',
  static: 'In the code',
  likely: 'Likely link',
  unknown: "Can't tell",
  fail: 'Failed',
};

/** Licenses we accept for official logos. Non-commercial licenses are excluded on purpose. */
export const EXCLUDED_LOGO_LICENSES = ['CC-BY-NC-SA-4.0', 'CC-BY-NC-SA-3.0', 'CC-BY-NC-4.0'];
