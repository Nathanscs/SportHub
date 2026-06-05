const CACHE_NAME = 'esports-tracker-v12';
const urlsToCache = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './config.js',
    './manifest.json'
];

// Instalação do SW e cache de arquivos básicos
self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
    );
});

// Ativação: remove caches antigos e assume controle imediatamente
self.addEventListener('activate', event => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(keys.map(key => (key !== CACHE_NAME ? caches.delete(key) : Promise.resolve())));
            await self.clients.claim();
        })()
    );
});

// Estratégia Network first (Rede primeiro, depois cache) para garantir atualizações imediatas online
self.addEventListener('fetch', event => {
    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Atualiza o cache dinamicamente com as respostas de sucesso
                if (response && response.status === 200 && response.type === 'basic') {
                    const responseToCache = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseToCache);
                    });
                }
                return response;
            })
            .catch(() => {
                // Retorna cache caso o usuário esteja offline
                return caches.match(event.request);
            })
    );
});

// Escuta notificações Push do Firebase
self.addEventListener('push', event => {
    const data = event.data ? event.data.json() : {};
    const title = data.notification?.title || 'Novo Evento eSports!';
    const options = {
        body: data.notification?.body || 'Acesse para ver os detalhes.',
        icon: 'https://cdn-icons-png.flaticon.com/512/3256/3256114.png',
        badge: 'https://cdn-icons-png.flaticon.com/512/3256/3256114.png'
    };
    event.waitUntil(self.registration.showNotification(title, options));
});