const sequelize = require('./config/database');
const VideoPart = require('./models/VideoPart');

async function checkHomeworkUrls() {
  try {
    const homeworkParts = await VideoPart.findAll({
      where: { category: 'homework_solution' },
      order: [['order_index', 'ASC']],
      limit: 10,
    });

    console.log('\n=== HOMEWORK SOLUTION VIDEPARTS ===');
    if (homeworkParts.length === 0) {
      console.log('❌ No homework solution videos found in VideoPart table');
    } else {
      console.log(`✅ Found ${homeworkParts.length} homework videos:\n`);
      homeworkParts.forEach(part => {
        console.log(`  VideoId: ${part.VideoId}`);
        console.log(`  Order: ${part.order_index}`);
        console.log(`  Type: ${part.source_type}`);
        console.log(`  URL: ${part.video_url || '(uploaded file)'}`);
        console.log();
      });
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await sequelize.close();
  }
}

checkHomeworkUrls();
