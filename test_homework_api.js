const sequelize = require('./config/database');
const VideoPart = require('./models/VideoPart');
const Video = require('./models/Video');
const Session = require('./models/Session');
const VideoSession = require('./models/VideoSession');

async function testHomeworkReturn() {
  try {
    // Get a sample homework video
    const homeworkVideo = await VideoPart.findOne({
      where: { category: 'homework_solution' },
    });

    if (!homeworkVideo) {
      console.log('❌ No homework videos found');
      await sequelize.close();
      return;
    }

    console.log('\n=== HOMEWORK VIDEO DETAILS ===');
    console.log(`ID: ${homeworkVideo.id}`);
    console.log(`VideoId: ${homeworkVideo.VideoId || '(NOT SET)'}`);
    console.log(`URL: ${homeworkVideo.video_url}`);
    console.log(`Category: ${homeworkVideo.category}`);

    // Try to find the video it's linked to
    if (homeworkVideo.VideoId) {
      const linkedVideo = await Video.findByPk(homeworkVideo.VideoId);
      console.log(`\nLinked Video: ${linkedVideo ? linkedVideo.title : 'NOT FOUND'}`);
    } else {
      console.log('\n⚠️ Homework video has no VideoId (not linked to specific video)');
      console.log('✓ But this is OK - it will use the global fallback homework URL');
    }

    // Test the fallback logic
    console.log('\n=== API RESPONSE SIMULATION ===');
    const homeworkParts = await VideoPart.findAll({
      where: { category: 'homework_solution' },
      order: [['order_index', 'ASC']],
      limit: 10,
    });

    const homeworkByVideoId = new Map();
    let globalHomeworkUrl = null;

    homeworkParts.forEach((part, index) => {
      if (index === 0 && part.video_url) {
        globalHomeworkUrl = part.video_url;
      }
      if (part.VideoId && !homeworkByVideoId.has(part.VideoId)) {
        homeworkByVideoId.set(part.VideoId, part.video_url || null);
      }
    });

    console.log(`\n✅ Global homework URL (fallback): ${globalHomeworkUrl}`);
    console.log(`✅ Video-specific homework URLs mapped: ${homeworkByVideoId.size}`);

    // Simulate what will be sent to student
    console.log('\n=== WHAT STUDENT WILL RECEIVE ===');
    const sampleVideoId = 1;
    const sessionHomeworkUrl = null; // assume no session.homework_video_url for now
    
    const finalUrl = homeworkByVideoId.get(sampleVideoId) || sessionHomeworkUrl || globalHomeworkUrl;
    console.log(`For Video ID ${sampleVideoId}:`);
    console.log(`  homeworkVideoUrl in API response: ${finalUrl}`);
    
    if (finalUrl) {
      console.log(`  ✅ Student will see homework card opening: ${finalUrl}`);
    } else {
      console.log(`  ❌ No homework URL available`);
    }

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await sequelize.close();
  }
}

testHomeworkReturn();
