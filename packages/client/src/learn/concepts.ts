/**
 * General explanations, curated and shipped with TraceNaut (no AI involved). They say
 * what a concept *is*; what it does in the inspected app comes from the journey's
 * evidence and is shown alongside ("In this app", "How TraceNaut knows").
 */

export type ConceptKind =
  | 'tool'
  | 'platform'
  | 'service'
  | 'language'
  | 'library'
  | 'framework'
  | 'runtime'
  | 'protocol'
  | 'data-format'
  | 'database'
  | 'browser-api'
  | 'idea'
  | 'syntax';

export interface Concept {
  name: string;
  kind: ConceptKind;
  /** One or two plain sentences. */
  short: string;
  /** Optional deeper explanation, shown on request. */
  more?: string;
  /** A tiny, generic illustration. */
  example?: string;
  /** What happens because of it, in general (an app-specific effect overrides this). */
  effect?: string;
}

export const KIND_LABEL: Record<ConceptKind, { label: string; what: string }> = {
  language: { label: 'Programming language', what: 'The notation the code is written in.' },
  library: { label: 'Library', what: 'Ready-made code written by others that this app calls when it needs it.' },
  framework: { label: 'Framework', what: 'Ready-made code that gives the app its structure and calls the app’s code at the right moments.' },
  runtime: { label: 'Runtime', what: 'The program that actually runs the code.' },
  protocol: { label: 'Protocol', what: 'Agreed rules two programs follow to talk to each other.' },
  'data-format': { label: 'Data format', what: 'A way of writing data down so another program can read it.' },
  database: { label: 'Database', what: 'A program that stores data and answers questions about it.' },
  'browser-api': { label: 'Browser feature', what: 'A capability built into the browser that code can use.' },
  tool: { label: 'Development tool', what: 'A program developers use to build, check or ship the app; it is not part of the running app itself.' },
  platform: { label: 'Platform', what: 'A service or environment the app runs on or is delivered through.' },
  service: { label: 'Service', what: 'A separate program or hosted service the app talks to.' },
  idea: { label: 'Concept', what: 'A programming idea.' },
  syntax: { label: 'Syntax', what: 'A piece of code notation.' },
};

export const CONCEPTS: Record<string, Concept> = {
  // ---------------------------------------------------------------- languages
  typescript: {
    name: 'TypeScript',
    kind: 'language',
    short: 'JavaScript with types added: you can say what kind of value something is (text, number, a User…) and mistakes are caught before the code runs.',
    more: 'Browsers and Node.js do not run TypeScript directly. A build step removes the types and produces plain JavaScript, so at runtime it behaves exactly like JavaScript.',
    example: 'function greet(name: string) { … }',
  },
  tsx: {
    name: 'TSX',
    kind: 'language',
    short: 'TypeScript that may also contain JSX: HTML-like tags describing what to show on screen. Files end in .tsx.',
    more: 'TSX is not a separate language from TypeScript; it is TypeScript plus the JSX notation. A build tool turns the tags into ordinary function calls that React understands.',
    example: 'return <button onClick={save}>Save</button>;',
  },
  javascript: {
    name: 'JavaScript',
    kind: 'language',
    short: 'The programming language of the web. Browsers run it, and Node.js runs it outside the browser, for example on servers.',
  },
  'jsx-js': {
    name: 'JavaScript + JSX',
    kind: 'language',
    short: 'JavaScript that also contains JSX: HTML-like tags describing what to show on screen.',
  },
  sql: {
    name: 'SQL',
    kind: 'language',
    short: 'A language for asking a database questions and changing its data: read rows, add rows, update or delete them.',
    more: 'Here the server holds SQL as text and hands it to the database, which understands and runs it. SQL is a separate language from the JavaScript around it.',
    example: 'SELECT name FROM users WHERE id = ?',
    effect: 'The database reads or changes rows and sends the result back to the server.',
  },
  orm: {
    name: 'ORM',
    kind: 'idea',
    short: 'Short for object-relational mapper: a library that lets code read and write database rows as objects, instead of writing SQL by hand.',
    more: 'The ORM still talks to the database in SQL. It writes that SQL itself, each time the code asks for something.',
    example: 'prisma.user.findUnique({ where: { id } })',
    effect: 'Calls in the code become SQL statements when they run.',
  },
  prisma: {
    name: 'Prisma',
    kind: 'library',
    short: 'An ORM for TypeScript and JavaScript. The database tables are described in a schema file, and Prisma generates code with one object per table (model).',
    more: 'Calls such as prisma.website.findMany() are turned into SQL by Prisma when they run. The generated code is usually not saved in the repository; `prisma generate` creates it.',
    example: 'await prisma.website.findUnique({ where: { id } })',
    effect: 'The server reads and writes the database through model calls; Prisma writes the SQL.',
  },

  // ---------------------------------------------------------------- libraries, frameworks
  react: {
    name: 'React',
    kind: 'library',
    short: 'A library for building user interfaces out of components: reusable pieces that describe part of the screen.',
    more: 'You describe what the screen should look like for the current data. When the data (state) changes, React works out what changed and updates the page.',
  },
  express: {
    name: 'Express',
    kind: 'framework',
    short: 'A framework for building web servers on Node.js. It receives HTTP requests and sends each one to the code registered for its address (a route).',
  },
  'node-sqlite': {
    name: 'node:sqlite',
    kind: 'library',
    short: 'A module built into Node.js for talking to SQLite databases: it sends SQL to the database and returns the results.',
  },
  'node-crypto': {
    name: 'node:crypto',
    kind: 'library',
    short: 'A module built into Node.js for cryptography: hashing passwords, comparing secrets safely, generating random tokens.',
  },
  'npm-package': {
    name: 'npm package',
    kind: 'library',
    short: 'Code published by someone else on npm, the JavaScript package registry, and installed into this project.',
  },

  // ---------------------------------------------------------------- runtimes, platform
  browser: {
    name: 'Web browser',
    kind: 'runtime',
    short: 'Runs the page: it draws the HTML, applies the styles and executes the JavaScript on your computer.',
  },
  nodejs: {
    name: 'Node.js',
    kind: 'runtime',
    short: 'A program that runs JavaScript outside the browser, typically on a server. It can listen for network requests, read files and talk to databases.',
  },
  fetch: {
    name: 'fetch()',
    kind: 'browser-api',
    short: 'A function built into the browser that sends an HTTP request and waits for the answer.',
    example: "fetch('/api/items', { method: 'POST' })",
    effect: 'A request leaves the browser; the code continues once the answer arrives.',
  },

  // ---------------------------------------------------------------- communication
  http: {
    name: 'HTTP',
    kind: 'protocol',
    short: 'The protocol browsers and servers use to talk. The browser sends a request (a method plus an address, sometimes with data) and the server sends back a response.',
    more: 'Each request is independent: the server answers it and the conversation is over. Anything the server should remember about you (such as being signed in) has to travel with each request, often as a cookie.',
    effect: 'Data crosses from the browser to the server and back.',
  },
  json: {
    name: 'JSON',
    kind: 'data-format',
    short: 'A text format for data, written like JavaScript objects. Both browser and server can turn it back into real data.',
    example: '{ "email": "ada@example.com", "remember": true }',
    effect: 'Data can travel as text and be rebuilt on the other side.',
  },
  'http-method': {
    name: 'HTTP method',
    kind: 'idea',
    short: 'The verb of an HTTP request. GET asks for data, POST sends new data, PATCH changes part of something, DELETE removes something.',
    effect: 'The server uses the method, together with the address, to pick which code runs.',
  },
  'request-body': {
    name: 'Request body',
    kind: 'idea',
    short: 'Data sent along with an HTTP request, for example the fields of a form. GET requests normally have none.',
  },
  'status-code': {
    name: 'Status code',
    kind: 'idea',
    short: 'A number in every HTTP response saying how it went: 2xx success, 4xx a problem with the request (401 = not authorised, 404 = not found), 5xx a server error.',
    effect: 'The browser code usually checks it to decide whether to show the result or an error.',
  },
  'base-url': {
    name: 'Base address',
    kind: 'idea',
    short: 'The first part of an address, such as https://api.example.com or /api, that the code puts in front of each request’s path.',
    more: 'It often comes from configuration (an environment variable), so it can differ between a developer’s computer and the live site. Reading the code shows the path; the base is only known when the app runs.',
    example: '`${apiBase}/websites/${id}`',
    effect: 'The same code can talk to different servers depending on how the app is set up.',
  },
  'file-routing': {
    name: 'File-based routing',
    kind: 'idea',
    short: 'Routes made from where files sit in folders, instead of being registered in code. The folder path becomes the address.',
    more: 'In Next.js, app/api/items/[id]/route.ts answers /api/items/<some id>: [id] is filled from the address, and folders in (parentheses) are left out of it.',
    example: 'app/api/items/[id]/route.ts → /api/items/:id',
    effect: 'Adding or moving a file adds or moves a route.',
  },
  route: {
    name: 'Route',
    kind: 'idea',
    short: 'A rule on the server: “requests with this method and address are handled by this code”.',
    example: "router.post('/login', handleLogin)",
    effect: 'A matching request runs that route’s code; others are passed on or answered with 404.',
  },
  middleware: {
    name: 'Middleware',
    kind: 'idea',
    short: 'Code that runs on a request before the route’s own code, for example to read the body or check that the user is signed in. It can let the request continue or answer it early.',
    effect: 'A request may be stopped (for example with 401) before the route’s code runs.',
  },
  'session-cookie': {
    name: 'Cookie',
    kind: 'idea',
    short: 'A small piece of data the server asks the browser to store and send back with every later request. It is often used to remember who is signed in.',
  },

  // ---------------------------------------------------------------- data
  sqlite: {
    name: 'SQLite',
    kind: 'database',
    short: 'A small database stored in a single file. The application talks to it directly, without a separate database server.',
  },
  postgresql: { name: 'PostgreSQL', kind: 'database', short: 'A widely used database server that stores data in tables and is queried with SQL.' },
  mysql: { name: 'MySQL', kind: 'database', short: 'A widely used database server that stores data in tables and is queried with SQL.' },
  'sql-placeholder': {
    name: '? placeholder',
    kind: 'syntax',
    short: 'A spot in an SQL statement that is filled in with a value when it runs. Passing values this way, instead of pasting them into the text, protects against SQL injection.',
  },
  'database-table': {
    name: 'Table',
    kind: 'idea',
    short: 'Where a database keeps one kind of record, in rows and columns: for example a users table with one row per user.',
  },

  // ---------------------------------------------------------------- page & React ideas
  'html-element': {
    name: 'Element',
    kind: 'idea',
    short: 'One piece of a web page, such as a button, a text box or a paragraph.',
  },
  'html-form': {
    name: 'Form',
    kind: 'idea',
    short: 'A group of inputs that is sent as a unit. Clicking a submit button inside a form “submits” it, which triggers the form’s submit event.',
  },
  'event-handler': {
    name: 'Event handler',
    kind: 'idea',
    short: 'A function attached to an element that runs when something happens to it: a click, a key press, a form being submitted.',
    example: '<button onClick={save}>',
  },
  'event-bubbling': {
    name: 'Event bubbling',
    kind: 'idea',
    short: 'An event that happens on an element also travels up to the elements that contain it, so a handler on a parent can react to clicks on its children.',
  },
  component: {
    name: 'Component',
    kind: 'idea',
    short: 'A reusable piece of the interface written as a function. It receives data (props), may keep its own data (state), and returns what to show.',
    example: 'function Greeting({ name }) { return <p>Hello {name}</p>; }',
  },
  props: {
    name: 'Props',
    kind: 'idea',
    short: 'Data a component receives from the component that draws it, like arguments to a function. Functions can be passed as props too, which is how a child can call its parent’s code.',
  },
  state: {
    name: 'State',
    kind: 'idea',
    short: 'Data a component remembers between redraws, such as “is this form being submitted?”. Changing it tells React to redraw.',
  },
  context: {
    name: 'React context',
    kind: 'idea',
    short: 'A way for a component to share data or functions with every component inside it, without passing them through each level as props.',
    more: 'Because the value is attached at runtime, reading the code alone cannot always prove which value a component receives. TraceNaut marks such links as likely and confirms them when you watch it happen.',
  },
  render: {
    name: 'Re-render',
    kind: 'idea',
    short: 'React runs a component’s function again to compute what it should show now, then updates only the parts of the page that changed.',
  },
  hook: {
    name: 'Hook',
    kind: 'idea',
    short: 'A function whose name starts with “use”, which lets a component use React features such as state. Apps can also write their own hooks to share logic.',
  },
  'use-state': {
    name: 'useState',
    kind: 'idea',
    short: 'A React hook that gives a component a piece of state and a function to change it. Changing it makes the component redraw.',
    example: 'const [count, setCount] = useState(0);',
  },
  'use-effect': {
    name: 'useEffect',
    kind: 'idea',
    short: 'A React hook for code that should run after the component is drawn, such as loading data from the server.',
    more: 'In development, React deliberately runs effects twice when a component first appears, to reveal bugs. A recording will show both runs.',
  },
  'use-callback': {
    name: 'useCallback',
    kind: 'idea',
    short: 'A React hook that keeps the same function between redraws instead of creating a new one each time.',
  },
  'use-memo': {
    name: 'useMemo',
    kind: 'idea',
    short: 'A React hook that remembers a computed value and only recomputes it when its inputs change.',
  },
  'use-context': {
    name: 'useContext',
    kind: 'idea',
    short: 'A React hook that reads the value shared by a context provider above the component.',
  },
  'component-usage': {
    name: 'Using a component',
    kind: 'syntax',
    short: 'A capitalised tag such as <Button> means “draw the Button component here”. The attributes become its props.',
  },
  'error-throw': {
    name: 'Throwing an error',
    kind: 'idea',
    short: 'Stopping the current work and signalling that something went wrong. Code further up can catch the error and react, for example by showing a message.',
  },
  function: {
    name: 'function',
    kind: 'syntax',
    short: 'Defines a named, reusable block of code that can receive inputs (parameters) and return a result.',
  },

  // ---------------------------------------------------------------- syntax
  jsx: {
    name: 'JSX tag',
    kind: 'syntax',
    short: 'HTML-like notation inside JavaScript or TypeScript describing what to show. It is turned into function calls before the code runs.',
  },
  'jsx-expression': {
    name: 'Curly braces in JSX',
    kind: 'syntax',
    short: 'Inside JSX, { … } switches back to normal code: the value inside is computed and used, for example a variable or a function.',
    example: '<p>{user.name}</p>',
  },
  'async-await': {
    name: 'async / await',
    kind: 'syntax',
    short: '“async” marks a function that can wait for slow work, like a network request. “await” pauses that function until the result arrives, without freezing the page.',
    example: 'const user = await login(email, password);',
  },
  'arrow-function': {
    name: 'Arrow function',
    kind: 'syntax',
    short: 'A compact way to write a function: (inputs) => result. Often used for small functions passed to other code.',
    example: '(x) => x * 2',
  },
  destructuring: {
    name: 'Destructuring',
    kind: 'syntax',
    short: 'Unpacks values from an object or array into separate variables in one step.',
    example: 'const { name, email } = user;',
  },
  'template-literal': {
    name: 'Template string',
    kind: 'syntax',
    short: 'Text in backticks where ${ … } inserts a computed value.',
    example: '`/api/tasks/${id}`',
  },
  spread: {
    name: 'Spread (...)',
    kind: 'syntax',
    short: 'Copies all the entries of an object or array into another one. In JSX, {...rest} passes along every remaining prop.',
  },
  'optional-chaining': {
    name: 'Optional chaining (?.)',
    kind: 'syntax',
    short: 'Reads a property only if the value before it exists; otherwise the result is undefined instead of an error.',
  },
  nullish: {
    name: 'Fallback (??)',
    kind: 'syntax',
    short: 'a ?? b means “use a, unless it is missing (null or undefined), then use b”.',
  },
  ternary: {
    name: 'Conditional (? :)',
    kind: 'syntax',
    short: 'condition ? a : b gives a when the condition is true, otherwise b. A one-line if/else that produces a value.',
  },
  'type-annotation': {
    name: 'Type annotation',
    kind: 'syntax',
    short: 'TypeScript notation saying what kind of value something holds. It is checked while writing the code and removed before it runs.',
    example: 'email: string',
  },
  'type-alias': {
    name: 'Type definition',
    kind: 'syntax',
    short: 'Gives a name to a shape of data (TypeScript only), so the code can say “this is a User” and be checked.',
  },
  generics: {
    name: 'Type parameter <…>',
    kind: 'syntax',
    short: 'Tells a function which type of data it will work with, for example what shape of answer a request returns. TypeScript only.',
  },
  'import-export': {
    name: 'import / export',
    kind: 'syntax',
    short: 'How files share code: one file exports a function or value, another imports it to use it.',
  },
  'try-catch': {
    name: 'try / catch',
    kind: 'syntax',
    short: 'Runs code in “try”; if an error is thrown, the “catch” block runs instead of the program crashing. “finally” runs either way.',
  },
  throw: {
    name: 'throw',
    kind: 'syntax',
    short: 'Stops the current function with an error. The nearest surrounding try / catch receives it.',
  },
  new: {
    name: 'new',
    kind: 'syntax',
    short: 'Creates a new object from a class, for example a new error describing what went wrong.',
  },
  variable: {
    name: 'const / let',
    kind: 'syntax',
    short: 'Declares a named value. const cannot be reassigned afterwards; let can.',
  },
};

export function concept(id: string): Concept | undefined {
  return CONCEPTS[id];
}
