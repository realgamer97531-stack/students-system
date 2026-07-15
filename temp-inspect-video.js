const Video = require('./models/Video');
const VideoPart = require('./models/VideoPart');
(async () => {
  const video = await Video.findOne({ order: [['createdAt', 'DESC']], include: [VideoPart] });
  console.log(JSON.stringify({
    videoId: video && video.id,
    title: video && video.title,
    parts: (video && video.VideoParts || []).map(p => ({
      id: p.id,
      category: p.category,
      source_type: p.source_type,
      video_url: p.video_url,
      file_path: p.file_path,
      order_index: p.order_index,
    }))
  }, null, 2));
})();
