// The element chain the browser client produces for the demo's "Sign in" button.
export const signInRequest = {
  adapter: 'react',
  element: { tag: 'button', text: 'Sign in', attributes: { type: 'submit', class: 'btn btn-primary' } },
  chain: [
    { type: 'host', name: 'button', loc: 'web/src/components/Button.tsx:10:4', runtimeHandlers: [] },
    { type: 'component', name: 'Button', loc: 'web/src/components/LoginForm.tsx:38:6' },
    { type: 'host', name: 'form', loc: 'web/src/components/LoginForm.tsx:26:4', runtimeHandlers: ['onSubmit'] },
  ],
};
