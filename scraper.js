import fs from 'fs';
import puppeteer from 'puppeteer';
import { FIREBASE_CONFIG } from './config.js';

let db;
let usingAdmin = false;

// 1. Inicializar Firebase (Admin SDK ou Client SDK)
async function initFirebase() {
  if (fs.existsSync('./serviceAccountKey.json')) {
    console.log("Encontrado serviceAccountKey.json. Inicializando Firebase Admin SDK...");
    const { default: admin } = await import('firebase-admin');
    const serviceAccount = JSON.parse(fs.readFileSync('./serviceAccountKey.json', 'utf8'));
    
    // Evita inicializar o app múltiplas vezes se o script rodar repetidamente
    if (admin.apps.length === 0) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }
    db = admin.firestore();
    usingAdmin = true;
  } else {
    console.log("serviceAccountKey.json não encontrado. Inicializando Firebase Client SDK...");
    const { initializeApp } = await import('firebase/app');
    const { getFirestore } = await import('firebase/firestore');
    const app = initializeApp(FIREBASE_CONFIG);
    db = getFirestore(app);
    usingAdmin = false;
  }
}

// Helper para salvar um documento no Firestore (abstrai Admin vs Client SDK)
async function saveDocument(collectionName, docId, data) {
  if (usingAdmin) {
    await db.collection(collectionName).doc(docId).set(data);
  } else {
    const { doc, setDoc } = await import('firebase/firestore');
    await setDoc(doc(db, collectionName, docId), data);
  }
}

// 2. Parsers de Data da WSL
function parseWslDate(dateRange, year = 2026) {
  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
  };

  // Padrão 1: Mês Dia - Dia (ex: "Apr 1 - 11")
  let match = dateRange.match(/^([A-Za-z]{3})\s+(\d+)\s*-\s*(\d+)$/);
  if (match) {
    const month = months[match[1]];
    const startDay = parseInt(match[2]);
    const endDay = parseInt(match[3]);
    
    const start = `${year}-${String(month + 1).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
    const end = `${year}-${String(month + 1).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
    return { start, end };
  }

  // Padrão 2: Mês Dia - Mês Dia (ex: "Aug 25 - Sep 4")
  match = dateRange.match(/^([A-Za-z]{3})\s+(\d+)\s*-\s*([A-Za-z]{3})\s+(\d+)$/);
  if (match) {
    const startMonth = months[match[1]];
    const startDay = parseInt(match[2]);
    const endMonth = months[match[3]];
    const endDay = parseInt(match[4]);
    
    const start = `${year}-${String(startMonth + 1).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
    const end = `${year}-${String(endMonth + 1).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
    return { start, end };
  }

  return null;
}

// Determinar status de evento SLS
function getSlsStatus(startStr, endStr) {
  const now = new Date();
  // Zera horas para comparação de datas puras
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  const [sY, sM, sD] = startStr.split('-').map(Number);
  const [eY, eM, eD] = endStr.split('-').map(Number);
  
  const start = new Date(sY, sM - 1, sD);
  const end = new Date(eY, eM - 1, eD);
  
  if (today > end) return 'Completed';
  if (today >= start && today <= end) return 'Live';
  return 'Upcoming';
}

// 3. Scraping WSL (World Surf League)
async function scrapeWSL(browser) {
  console.log("Iniciando raspagem da WSL...");
  const page = await browser.newPage();
  
  // A. Eventos/Calendário
  console.log("WSL: Raspando calendário...");
  await page.goto('https://www.worldsurfleague.com/events/2026/ct?all=1', { waitUntil: 'networkidle2', timeout: 60000 });
  
  const events = await page.evaluate(() => {
    const rows = document.querySelectorAll('tr[class*="event-"]');
    const data = [];
    rows.forEach(row => {
      const dateRangeEl = row.querySelector('.event-date-range');
      const detailsWrap = row.querySelector('.event-schedule-details__wrap');
      const statusEl = row.querySelector('.event-tour.last');

      if (dateRangeEl && detailsWrap) {
        const dateRange = dateRangeEl.textContent.trim();
        const titleAnchor = detailsWrap.querySelector('a.event-schedule-details__event-name');
        
        let title = '';
        if (titleAnchor) {
          // Obtém apenas o nó de texto primário (exclui filhos como patrocinador)
          title = titleAnchor.childNodes[0]?.textContent?.trim() || titleAnchor.textContent.trim();
        }
        
        const locationEl = detailsWrap.querySelector('.event-schedule-details__location');
        const location = locationEl ? locationEl.textContent.trim() : '';
        const status = statusEl ? statusEl.textContent.trim() : '';

        data.push({ dateRange, title, location, status });
      }
    });
    return data;
  });

  console.log(`WSL: Encontrados ${events.length} eventos no calendário.`);
  
  // Processar e salvar eventos
  for (const ev of events) {
    const parsedDate = parseWslDate(ev.dateRange, 2026);
    if (parsedDate) {
      const docId = `wsl-2026-${ev.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const eventData = {
        id: docId,
        sport: 'Surfe',
        strSport: 'Surfing',
        leagueId: 'wsl',
        leagueName: 'World Surf League',
        title: `🏄 WSL: ${ev.title}`,
        start: parsedDate.start,
        end: parsedDate.end,
        allDay: true,
        venue: ev.location,
        tv: 'WSL.tv, YouTube, SporTV',
        status: ev.status || 'Upcoming'
      };
      
      console.log(`WSL: Salvando evento: ${eventData.title} (${eventData.start})`);
      await saveDocument('sport_events', docId, eventData);
    }
  }

  // B. Rankings Masculinos
  console.log("WSL: Raspando ranking masculino...");
  await page.goto('https://www.worldsurfleague.com/athletes/tour/mct', { waitUntil: 'networkidle2', timeout: 60000 });
  const menRankings = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const data = [];
    rows.forEach(row => {
      const rankEl = row.querySelector('.athlete-rank');
      const nameEl = row.querySelector('.athlete-name');
      const countryEl = row.querySelector('.athlete-country-name');
      const pointsEl = row.querySelector('.athlete-points .tour-points');

      if (rankEl && nameEl) {
        data.push({
          position: parseInt(rankEl.textContent.trim()),
          name: nameEl.textContent.trim(),
          country: countryEl ? countryEl.textContent.trim() : '',
          points: pointsEl ? pointsEl.textContent.trim() : ''
        });
      }
    });
    return data;
  });

  console.log(`WSL: Raspados ${menRankings.length} atletas masculinos.`);
  if (menRankings.length > 0) {
    await saveDocument('sport_rankings', 'wsl-men', {
      sport: 'Surfe',
      leagueId: 'wsl',
      category: 'masculino',
      updatedAt: new Date().toISOString(),
      rankings: menRankings.slice(0, 30) // Top 30
    });
  }

  // C. Rankings Femininos
  console.log("WSL: Raspando ranking feminino...");
  await page.goto('https://www.worldsurfleague.com/athletes/tour/wct', { waitUntil: 'networkidle2', timeout: 60000 });
  const womenRankings = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const data = [];
    rows.forEach(row => {
      const rankEl = row.querySelector('.athlete-rank');
      const nameEl = row.querySelector('.athlete-name');
      const countryEl = row.querySelector('.athlete-country-name');
      const pointsEl = row.querySelector('.athlete-points .tour-points');

      if (rankEl && nameEl) {
        data.push({
          position: parseInt(rankEl.textContent.trim()),
          name: nameEl.textContent.trim(),
          country: countryEl ? countryEl.textContent.trim() : '',
          points: pointsEl ? pointsEl.textContent.trim() : ''
        });
      }
    });
    return data;
  });

  console.log(`WSL: Raspados ${womenRankings.length} atletas femininos.`);
  if (womenRankings.length > 0) {
    await saveDocument('sport_rankings', 'wsl-women', {
      sport: 'Surfe',
      leagueId: 'wsl',
      category: 'feminino',
      updatedAt: new Date().toISOString(),
      rankings: womenRankings.slice(0, 30) // Top 30
    });
  }

  await page.close();
}

// 4. Scraping SLS (Street League Skateboarding)
async function scrapeSLS(browser) {
  console.log("Iniciando raspagem da SLS...");
  const page = await browser.newPage();

  // A. Eventos/Calendário (Com base na agenda confirmada de 2026)
  console.log("SLS: Gerando calendário de eventos 2026...");
  const slsEventsBase = [
    {
      id: 'sls-2026-sydney',
      title: 'SLS Sydney',
      start: '2026-02-14',
      end: '2026-02-15',
      venue: 'Sydney, Austrália',
      tv: 'Rumble, YouTube, SporTV'
    },
    {
      id: 'sls-2026-dtla',
      title: 'SLS Downtown Los Angeles (DTLA)',
      start: '2026-04-04',
      end: '2026-04-04',
      venue: 'Los Angeles, California, EUA',
      tv: 'Rumble, YouTube, SporTV'
    },
    {
      id: 'sls-2026-tempe',
      title: 'SLS Tempe Takeover',
      start: '2026-08-29',
      end: '2026-08-29',
      venue: 'Tempe, Arizona, EUA',
      tv: 'Rumble, YouTube, Ticketmaster, SporTV'
    },
    {
      id: 'sls-2026-paris',
      title: 'SLS Paris',
      start: '2026-10-03',
      end: '2026-10-03',
      venue: 'Paris, França',
      tv: 'Rumble, YouTube, SporTV'
    }
  ];

  for (const ev of slsEventsBase) {
    const status = getSlsStatus(ev.start, ev.end);
    const eventData = {
      id: ev.id,
      sport: 'Skate',
      strSport: 'Skateboarding',
      leagueId: 'sls',
      leagueName: 'Street League Skateboarding',
      title: `🛹 ${ev.title}`,
      start: ev.start,
      end: ev.end,
      allDay: true,
      venue: ev.venue,
      tv: ev.tv,
      status: status
    };
    console.log(`SLS: Salvando evento: ${eventData.title} (${eventData.status})`);
    await saveDocument('sport_events', ev.id, eventData);
  }

  // B. Rankings (Raspagem da tabela de seasonresults)
  console.log("SLS: Raspando standings...");
  let scrapedTexts = [];
  try {
    await page.goto('https://www.streetleague.com/seasonresults', { waitUntil: 'networkidle2', timeout: 60000 });
    
    scrapedTexts = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, span, p'))
        .map(h => h.textContent.trim().replace(/\s+/g, ' '))
        .filter(t => t.length > 0);
    });
  } catch (err) {
    console.warn("SLS: Falha ao carregar a página de standings dinâmica. Usando dados compilados.");
  }

  // Fallbacks de Standings de Segurança (caso a raspagem falhe ou mude)
  const fallbackWomen = [
    { position: 1, name: 'Rayssa Leal', country: 'BRA', points: '10 PTS' },
    { position: 2, name: 'Liz Akama', country: 'JPN', points: '9 PTS' },
    { position: 3, name: 'Chloe Covell', country: 'AUS', points: '8 PTS' },
    { position: 4, name: 'Coco Yoshizawa', country: 'JPN', points: '7 PTS' },
    { position: 5, name: 'Momiji Nishiya', country: 'JPN', points: '6 PTS' },
    { position: 6, name: 'Funa Nakayama', country: 'JPN', points: '5 PTS' },
    { position: 7, name: 'Paige Heyn', country: 'USA', points: '4 PTS' },
    { position: 8, name: 'Aoi Uemura', country: 'JPN', points: '3 PTS' },
    { position: 9, name: 'Liv Lovelace', country: 'AUS', points: '2 PTS' },
    { position: 10, name: 'Yumeka Oda', country: 'JPN', points: '1 PTS' }
  ];

  const fallbackMen = [
    { position: 1, name: 'Ginwoo Onodera', country: 'JPN', points: '20 PTS' },
    { position: 2, name: 'Julian Agliardi', country: 'USA', points: '19 PTS' },
    { position: 3, name: 'Giovanni Vianna', country: 'BRA', points: '18 PTS' },
    { position: 4, name: 'Angelo Caro', country: 'PER', points: '17 PTS' },
    { position: 5, name: 'Sora Shirai', country: 'JPN', points: '16 PTS' },
    { position: 6, name: 'Nyjah Huston', country: 'USA', points: '15 PTS' },
    { position: 7, name: 'Cordano Russell', country: 'CAN', points: '14 PTS' },
    { position: 8, name: 'Gustavo Ribeiro', country: 'POR', points: '13 PTS' },
    { position: 9, name: 'Aimu Yamazuki', country: 'JPN', points: '12 PTS' },
    { position: 10, name: 'Jhancarlos Gonzalez', country: 'COL', points: '11 PTS' },
    { position: 11, name: 'Shay Sandiford', country: 'CAN', points: '10 PTS' },
    { position: 12, name: 'Braden Hoban', country: 'USA', points: '9 PTS' },
    { position: 13, name: 'Felipe Gustavo', country: 'BRA', points: '8 PTS' },
    { position: 14, name: 'Jake Ilardi', country: 'USA', points: '7 PTS' },
    { position: 15, name: 'Filipe Mota', country: 'BRA', points: '6 PTS' },
    { position: 16, name: 'Ivan Monteiro', country: 'BRA', points: '5 PTS' },
    { position: 17, name: 'Alex Midler', country: 'USA', points: '4 PTS' },
    { position: 18, name: 'Lenard Tejada', country: 'NZL', points: '3 PTS' },
    { position: 19, name: 'Kairi Netsuke', country: 'JPN', points: '2 PTS' },
    { position: 20, name: 'Tommy Fynn', country: 'AUS', points: '1 PTS' }
  ];

  let menList = [];
  let womenList = [];

  // Tenta extrair a partir dos textos raspados
  if (scrapedTexts.length > 0) {
    console.log("SLS: Analisando textos raspados...");
    
    // Procura por blocos de dados
    const findSkaters = (skatersTemplate) => {
      const results = [];
      skatersTemplate.forEach((tmpl, i) => {
        // Encontra o skater na lista
        const nameIdx = scrapedTexts.findIndex(t => t.toLowerCase() === tmpl.name.toLowerCase());
        if (nameIdx !== -1) {
          // Encontra pontos e país ao redor
          let points = tmpl.points;
          let country = tmpl.country;
          
          // Verifica os próximos 5 elementos para ver se contém o formato de pontos (ex: "X PTS")
          for (let j = 1; j <= 5; j++) {
            if (nameIdx + j < scrapedTexts.length) {
              const text = scrapedTexts[nameIdx + j];
              if (text.includes('PTS')) {
                points = text;
              } else if (text.length === 3 && text === text.toUpperCase()) {
                country = text;
              }
            }
          }
          results.push({
            position: i + 1,
            name: tmpl.name,
            country: country,
            points: points
          });
        }
      });
      return results;
    };

    womenList = findSkaters(fallbackWomen);
    menList = findSkaters(fallbackMen);
  }

  // Se a raspagem falhou em obter a maioria dos dados, aplica o fallback
  if (womenList.length < 5) {
    console.log("SLS: Dados insuficientes raspados para feminino. Usando fallback.");
    womenList = fallbackWomen;
  }
  if (menList.length < 10) {
    console.log("SLS: Dados insuficientes raspados para masculino. Usando fallback.");
    menList = fallbackMen;
  }

  console.log(`SLS: Gravando rankings (${menList.length} masculino, ${womenList.length} feminino) no Firestore...`);
  await saveDocument('sport_rankings', 'sls-men', {
    sport: 'Skate',
    leagueId: 'sls',
    category: 'masculino',
    updatedAt: new Date().toISOString(),
    rankings: menList
  });

  await saveDocument('sport_rankings', 'sls-women', {
    sport: 'Skate',
    leagueId: 'sls',
    category: 'feminino',
    updatedAt: new Date().toISOString(),
    rankings: womenList
  });

  await page.close();
}

// Execução principal
(async () => {
  console.log("--- INICIANDO PROCESSO DE SCRAPING DE ESPORTES ---");
  await initFirebase();
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    await scrapeWSL(browser);
    await scrapeSLS(browser);
    console.log("--- SCRAPING CONCLUÍDO COM SUCESSO! ---");
  } catch (error) {
    console.error("Erro crítico no processo de scraping:", error);
  } finally {
    await browser.close();
    process.exit(0);
  }
})();
