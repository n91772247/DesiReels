import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { DatabaseStore } from './server/db/store.js';
import { DiscoveryEngine } from './server/engine/discoveryEngine.js';
import { BackgroundScheduler } from './server/engine/scheduler.js';
import { SYSTEM_CATEGORIES } from './server/engine/categorizer.js';
import { createAdapterForSource } from './server/adapters/registry.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// Support reverse proxy headers in Cloud Run and production hosting
app.set('trust proxy', 1);

app.use(express.json());

// Initialize store, engine, and background scheduler
const store = DatabaseStore.getInstance();
const engine = DiscoveryEngine.getInstance();
const scheduler = BackgroundScheduler.getInstance();
scheduler.init();

// ----------------- API ROUTES -----------------

// 1. Videos listing & search
app.get('/api/videos', (req, res) => {
  try {
    const { category, sourceId, status, search, sortBy, limit, offset } = req.query;
    const result = store.getVideos({
      category: category as string,
      sourceId: sourceId as string,
      status: status as string,
      search: search as string,
      sortBy: (sortBy as any) || 'trending',
      limit: limit ? parseInt(limit as string, 10) : 50,
      offset: offset ? parseInt(offset as string, 10) : 0,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to query videos' });
  }
});

// Single video
app.get('/api/videos/:id', (req, res) => {
  const video = store.getVideoById(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  res.json(video);
});

// Video update (Video Manager)
app.put('/api/videos/:id', (req, res) => {
  try {
    const updated = store.updateVideo(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Video not found' });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Video delete
app.delete('/api/videos/:id', (req, res) => {
  const success = store.deleteVideo(req.params.id);
  if (!success) return res.status(404).json({ error: 'Video not found or already deleted' });
  res.json({ success: true, message: 'Video deleted successfully' });
});

// 2. Categories with active video counts
app.get('/api/categories', (req, res) => {
  const allVideos = store.getVideos({ status: 'published', limit: 1000 }).videos;
  const categoriesWithCounts = SYSTEM_CATEGORIES.map((cat) => {
    const count = allVideos.filter(
      (v) => v.category_id.toLowerCase() === cat.id.toLowerCase() || v.category_name.toLowerCase() === cat.name.toLowerCase()
    ).length;
    return {
      ...cat,
      videoCount: count,
    };
  });
  res.json(categoriesWithCounts);
});

// 3. Sources listing & management
app.get('/api/sources', (req, res) => {
  // Never expose credentials to browser
  const sources = store.getSources(false);
  res.json(sources);
});

app.post('/api/sources', (req, res) => {
  try {
    const newSource = store.upsertSource(req.body);
    // Return sanitized source
    res.json({
      ...newSource,
      api_credentials: newSource.api_credentials?.apiKey ? { apiKey: '••••••••••••••••' } : undefined,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/sources/:id', (req, res) => {
  try {
    const updated = store.upsertSource({ ...req.body, id: req.params.id });
    res.json({
      ...updated,
      api_credentials: updated.api_credentials?.apiKey ? { apiKey: '••••••••••••••••' } : undefined,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete configured site source
app.delete('/api/sources/:id', (req, res) => {
  try {
    const { id } = req.params;
    const deleteVideos = req.query.deleteVideos === 'true' || req.body?.deleteVideos === true;
    const result = store.deleteSource(id, deleteVideos);
    if (!result.success) {
      return res.status(404).json({ error: `Source with ID "${id}" not found` });
    }
    res.json({
      success: true,
      message: `Configured site "${result.deletedSource?.name}" was deleted successfully.${
        result.deletedVideosCount > 0 ? ` Cleaned up ${result.deletedVideosCount} imported videos.` : ''
      }`,
      deletedSourceId: id,
      deletedSourceName: result.deletedSource?.name,
      deletedVideosCount: result.deletedVideosCount,
      activeConfig: store.getActiveSourceConfig(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Test connection endpoint
app.post('/api/sources/test', async (req, res) => {
  try {
    let sourceConfig = req.body;
    // If source ID provided without credentials, resolve stored credentials from server
    if (sourceConfig.id && (!sourceConfig.api_credentials || sourceConfig.api_credentials.apiKey === '••••••••••••••••')) {
      const stored = store.getSourceById(sourceConfig.id, true);
      if (stored) {
        sourceConfig = { ...stored, ...sourceConfig, api_credentials: stored.api_credentials };
      }
    }
    const adapter = createAdapterForSource(sourceConfig);
    const result = await adapter.testConnection();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({
      success: false,
      message: err.message || 'Connection test failed',
    });
  }
});

// 4. Discovery live search & manual/bulk import
app.get('/api/discovery/search', async (req, res) => {
  try {
    const { q, sourceId, limit, category, sort } = req.query;
    if (!q || typeof q !== 'string') {
      return res.status(400).json({ error: 'Search query "q" parameter is required' });
    }
    const data = await engine.liveSearch(q, {
      sourceId: sourceId as string,
      limit: limit ? parseInt(limit as string, 10) : 15,
      category: category as string,
      sort: sort as string,
    });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4b. Discover videos from ANY specific website or app of admin's choice (e.g., YouTube, Vimeo, Dailymotion, Twitch, Reddit, or any custom URL/domain)
app.post('/api/discovery/website-search', async (req, res) => {
  try {
    const { website, query, mode, limit, category, sort } = req.body;
    if (!website || typeof website !== 'string') {
      return res.status(400).json({ error: 'Field "website" (URL, domain, or app name) is required' });
    }
    const data = await engine.searchCustomWebsiteOrApp(website, {
      query,
      mode,
      limit: limit ? parseInt(limit, 10) : 15,
      category,
      sort,
    });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/discovery/website-search', async (req, res) => {
  try {
    const { website, q, mode, limit, category, sort } = req.query;
    if (!website || typeof website !== 'string') {
      return res.status(400).json({ error: 'Query parameter "website" is required' });
    }
    const data = await engine.searchCustomWebsiteOrApp(website as string, {
      query: q as string,
      mode: mode as any,
      limit: limit ? parseInt(limit as string, 10) : 15,
      category: category as string,
      sort: sort as string,
    });
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4c. Save any custom searched website as permanent source & set as active auto-collection target
app.post('/api/discovery/website-save-and-target', async (req, res) => {
  try {
    const { websiteUrl, websiteName, category = 'Entertainment', updateInterval = '1h' } = req.body;
    if (!websiteUrl) {
      return res.status(400).json({ error: 'Field "websiteUrl" is required' });
    }

    let cleanUrl = websiteUrl.trim().replace(/\/+$/, '');
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      if (!cleanUrl.includes('.')) {
        cleanUrl = `${cleanUrl}.com`;
      }
      cleanUrl = `https://${cleanUrl}`;
    } else {
      try {
        const u = new URL(cleanUrl);
        if (!u.hostname.includes('.') && u.hostname !== 'localhost') {
          u.hostname = `${u.hostname}.com`;
          cleanUrl = u.toString().replace(/\/+$/, '');
        }
      } catch {
        // keep as is
      }
    }
    const cleanDomain = cleanUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    const cleanName =
      websiteName ||
      (cleanDomain.split('.')[0].charAt(0).toUpperCase() + cleanDomain.split('.')[0].slice(1));

    // Check if source already exists
    const existingSources = store.getSources(true);
    let matched = existingSources.find(
      (s) =>
        s.website_url.toLowerCase().includes(cleanDomain.toLowerCase()) ||
        s.name.toLowerCase() === cleanName.toLowerCase()
    );

    let sourceId: string;
    if (matched) {
      sourceId = matched.id;
    } else {
      matched = store.upsertSource({
        name: cleanName,
        website_url: cleanUrl,
        enabled: true,
        update_interval: updateInterval as any,
        ingestion_method: 'Public Syndication',
        default_category: category,
        search_keywords: [cleanName, 'trending', 'video'],
        max_videos_per_import: 25,
        last_successful_sync: null,
        last_sync_status: 'idle',
      });
      sourceId = matched.id;
    }

    // Trigger immediate sync on this newly selected website
    let itemsImported = 0;
    try {
      const syncResult = await engine.syncSource(sourceId);
      itemsImported = syncResult.videosImported;
    } catch (e: any) {
      console.warn(`[DesiReels] Auto-sync notice for ${cleanName}:`, e.message);
    }

    // Set as active automated collection source
    const updatedConfig = store.setActiveSourceId(sourceId, itemsImported);

    res.json({
      success: true,
      source: matched,
      activeConfig: updatedConfig,
      message: `Website "${cleanName}" (${cleanUrl}) is now saved and activated as your continuous trending auto-collection source! (${itemsImported} videos indexed)`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});


app.post('/api/discovery/import', (req, res) => {
  try {
    const { videos, overrides } = req.body;
    if (!Array.isArray(videos) || videos.length === 0) {
      return res.status(400).json({ error: 'Array of "videos" is required' });
    }
    const result = engine.importRawVideos(videos, overrides);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Trigger discovery sync
app.post('/api/sync/run', async (req, res) => {
  try {
    const { sourceId } = req.body;
    if (sourceId) {
      const result = await engine.syncSource(sourceId);
      return res.json({ success: true, results: [result] });
    } else {
      const results = await engine.syncAllSources();
      return res.json({ success: true, results });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5b. Active Site for Automatic Trending Video/Thumbnail Collection
app.get('/api/sync/active-source', (req, res) => {
  res.json(store.getActiveSourceConfig());
});

app.post('/api/sync/active-source', async (req, res) => {
  try {
    const { sourceId, triggerImmediate = true } = req.body;
    if (!sourceId) {
      return res.status(400).json({ error: 'sourceId parameter is required' });
    }

    let syncResult = null;
    let itemsImported = 0;

    // When admin selects a site, automatically collect trending videos & thumbnails from it immediately!
    if (triggerImmediate) {
      if (sourceId !== 'all') {
        const source = store.getSourceById(sourceId);
        if (source) {
          console.log(`[DesiReels] Admin selected site "${source.name}". Automatically collecting trending videos & thumbnails now...`);
          syncResult = await engine.syncSource(sourceId);
          itemsImported = syncResult.videosImported;
        }
      } else {
        console.log('[DesiReels] Admin set active site to Default (All Authorized Sources). Initiating multi-source discovery...');
        const results = await engine.syncAllSources();
        itemsImported = results.reduce((acc, r) => acc + r.videosImported, 0);
        syncResult = results;
      }
    }

    const updatedConfig = store.setActiveSourceId(sourceId, itemsImported);

    res.json({
      success: true,
      ...updatedConfig,
      syncResult,
      message:
        sourceId === 'all'
          ? 'Active collection source reset to Default (All Sources). Rotational indexing active.'
          : `Active collection source switched to ${updatedConfig.sourceName}. Trending thumbnails & video metadata collected automatically!`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5c. Ad Banners Management API
app.get('/api/ads', (req, res) => {
  res.json(store.getAdBanners());
});

app.put('/api/ads/:id', (req, res) => {
  try {
    const updated = store.updateAdBanner(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Ad slot banner not found' });
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ads/batch', (req, res) => {
  try {
    const { banners } = req.body;
    if (!Array.isArray(banners)) return res.status(400).json({ error: 'Array of banners required' });
    const updated = store.updateAdBanners(banners);
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Scheduler configuration
app.get('/api/sync/schedule', (req, res) => {
  res.json(store.getSchedulerConfig());
});

app.post('/api/sync/schedule', (req, res) => {
  try {
    const updated = store.updateSchedulerConfig(req.body);
    scheduler.reschedule();
    res.json(updated);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Trending Algorithm weights
app.get('/api/algorithm', (req, res) => {
  res.json(store.getAlgorithmWeights());
});

app.post('/api/algorithm', (req, res) => {
  try {
    const updated = store.updateAlgorithmWeights(req.body);
    res.json({ weights: updated, message: 'Weights updated and all trend scores recalculated successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Import Logs
app.get('/api/logs', (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
  res.json(store.getImportLogs(limit));
});

// 9. Dashboard overview stats
app.get('/api/stats', (req, res) => {
  const allVideos = store.getVideos({ status: 'all', limit: 2000 }).videos;
  const sources = store.getSources(false);
  const logs = store.getImportLogs(100);

  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

  const totalVideos = allVideos.length;
  const videosToday = allVideos.filter((v) => new Date(v.discovered_at).getTime() >= oneDayAgo).length;
  const videosThisWeek = allVideos.filter((v) => new Date(v.discovered_at).getTime() >= sevenDaysAgo).length;
  const publishedVideos = allVideos.filter((v) => v.status === 'published').length;
  const pendingReview = allVideos.filter((v) => v.status === 'pending').length;
  const trendingVideos = allVideos.filter((v) => v.status === 'published' && v.trend_score >= 80).length;
  const activeSources = sources.filter((s) => s.enabled).length;
  const failedImports = logs.filter((l) => l.status === 'error').length;

  res.json({
    totalVideos,
    videosToday,
    videosThisWeek,
    publishedVideos,
    pendingReview,
    trendingVideos,
    activeSources,
    totalSources: sources.length,
    failedImports,
  });
});

// 10. Sitemap & Robots.txt for SEO
app.get('/sitemap.xml', (req, res) => {
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol || 'https';
  const baseUrl = process.env.APP_URL ? process.env.APP_URL.replace(/\/+$/, '') : `${protocol}://${host}`;
  const videos = store.getVideos({ status: 'published', limit: 500 }).videos;

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
  xml += `  <url><loc>${baseUrl}/</loc><changefreq>hourly</changefreq><priority>1.0</priority></url>\n`;
  xml += `  <url><loc>${baseUrl}/videos</loc><changefreq>hourly</changefreq><priority>0.9</priority></url>\n`;

  SYSTEM_CATEGORIES.forEach((cat) => {
    xml += `  <url><loc>${baseUrl}/videos/${cat.slug}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>\n`;
  });

  videos.forEach((vid) => {
    xml += `  <url><loc>${baseUrl}/video/${vid.id}</loc><lastmod>${vid.updated_at.split('T')[0]}</lastmod><changefreq>weekly</changefreq><priority>0.7</priority></url>\n`;
  });

  xml += `</urlset>`;
  res.header('Content-Type', 'application/xml');
  res.send(xml);
});

app.get('/robots.txt', (req, res) => {
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol || 'https';
  const baseUrl = process.env.APP_URL ? process.env.APP_URL.replace(/\/+$/, '') : `${protocol}://${host}`;
  res.header('Content-Type', 'text/plain');
  res.send(`User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${baseUrl}/sitemap.xml\n`);
});

// ----------------- VITE MIDDLEWARE / STATIC FILES -----------------

async function startServer() {
  if (!isProduction) {
    process.env.DISABLE_HMR = 'true';
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`[DesiReels] Video Discovery Server running on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[DesiReels] Fatal server startup error:', err);
  process.exit(1);
});
