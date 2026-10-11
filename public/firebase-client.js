// Only the public Firebase Web configuration belongs in the frontend.
// Firebase Hosting supplies it automatically through its reserved init endpoint.
// Secrets, Gmail passwords, refresh tokens and the dashboard lock stay on the server.
export async function initializeIdentity(onUser) {
  let response = await fetch('/__/firebase/init.json', { cache: 'no-store' });
  if (!response.ok || !response.headers.get('content-type')?.includes('json')) {
    response = await fetch('/firebase-config.json', { cache: 'no-store' });
  }
  if (!response.ok || !response.headers.get('content-type')?.includes('json')) throw new Error('Firebase is not configured yet. Follow SETUP.md, or open the demo to explore the interface.');
  const config = await response.json();
  if (!config.apiKey || !config.authDomain || !config.projectId) throw new Error('The Firebase Web configuration is incomplete.');
  const [appSDK, authSDK] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js')
  ]);
  const app = appSDK.initializeApp(config);
  const auth = authSDK.getAuth(app);
  await authSDK.setPersistence(auth, authSDK.browserLocalPersistence);
  const provider = new authSDK.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const unsubscribe = authSDK.onAuthStateChanged(auth, onUser);
  return { auth, unsubscribe, signIn: () => authSDK.signInWithPopup(auth, provider), signOut: () => authSDK.signOut(auth) };
}
