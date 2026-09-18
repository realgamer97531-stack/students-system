require('dotenv').config();
const sequelize = require('./config/database');
const Center = require('./models/Center');
const Subject = require('./models/Subject');
const CenterSubjectSeries = require('./models/CenterSubjectSeries');
require('./models/associations')();

async function seed() {
  try {
    await sequelize.sync();

    const centers = [
      'جلوري الإقبال',
      'الأكاديمية سموحة',
      'الرياض ميامي',
      'صقر السيوف',
      'صقر ميامي',
      'محرم بيك',
      'أونلاين',
      'No Follow up Online',
    ];

    for (const name of centers) {
      await Center.findOrCreate({ where: { name } });
    }

    const subjects = [
      { name: 'ماث أولى ثانوي', default_price: 80 },
      { name: 'ماث تانية ثانوي', default_price: 90 },
      { name: 'فيزيكس تانية ثانوي', default_price: 90 },
      { name: 'ماث تالتة ثانوي', default_price: 90 },
      { name: 'فيزيكس تالتة ثانوي', default_price: 90 },
      { name: 'إحصاء تالتة ثانوي', default_price: 90 },
    ];

    for (const subj of subjects) {
      await Subject.findOrCreate({ where: { name: subj.name }, defaults: subj });
    }

    // نحدد أساس مختلف لكل سنتر (تقدر تغيّر الأرقام دي براحتك بعدين)
    const centerBases = {
      'جلوري الإقبال': 1000,
      'الأكاديمية سموحة': 2000,
      'الرياض ميامي': 3000,
      'صقر السيوف': 4000,
      'صقر ميامي': 5000,
      'محرم بيك': 6000,
      'أونلاين': 9000,
      'No Follow up Online': 7000,
    };

    const allCenters = await Center.findAll();
    const allSubjects = await Subject.findAll();

    for (const center of allCenters) {
      for (const subject of allSubjects) {
        await CenterSubjectSeries.findOrCreate({
          where: { CenterId: center.id, SubjectId: subject.id },
          defaults: { base_number: centerBases[center.name] || 1000 },
        });
      }
    }

    console.log('✅ تمت تعبية البيانات الأولية بنجاح');
    process.exit(0);
  } catch (error) {
    console.error('❌ خطأ:', error.message);
    process.exit(1);
  }
}

seed();