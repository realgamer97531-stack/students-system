require('dotenv').config({ path: '.env' });
const sequelize = require('./config/database');
const FollowUpAssignment = require('./models/FollowUpAssignment');
const User = require('./models/User');
const Student = require('./models/Student');
const setupAssociations = require('./models/associations');
setupAssociations();
(async () => {
  try {
    await sequelize.authenticate();
    console.log('DB OK');
    const student = await Student.findOne();
    console.log('Test student', student ? student.id : 'none');

    const assignment = await FollowUpAssignment.findOne({
      where: { StudentId: student ? student.id : 0 },
      include: [{ model: User, as: 'Assistant', attributes: ['name', 'phone'] }],
    });
    console.log('Assignment', assignment ? assignment.toJSON() : 'none');
  } catch (err) {
    console.error('ERROR', err);
    if (err.original) console.error('original', err.original.sqlMessage || err.original.message || err.original);
  } finally {
    await sequelize.close();
    process.exit(0);
  }
})();