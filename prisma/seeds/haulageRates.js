const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const haulageRatesData = [
  { location: 'ososa', km: 2.8, rate15: 62647.96, rate20: 81442.35, rate30: 97104.34, code: '1265' },
  { location: 'Ijebu ode', km: 11, rate15: 73358.96, rate20: 95366.65, rate30: 113706.38, code: '1250' },
  // Add all from your Excel
];

const salaryRatesData = [
  { location: 'ABA', tripAllow: 6000, driver: 10000, motorBoy: 4500 },
  { location: 'ABAK', tripAllow: 6000, driver: 10000, motorBoy: 4500 },
  // Add all from your Excel
];

async function seedRates() {
  for (const data of haulageRatesData) {
    const location = await prisma.location.findFirst({
      where: { name: { equals: data.location, mode: 'insensitive' } }
    });
    
    if (location) {
      await prisma.haulageRate.create({
        data: {
          locationId: location.id,
          locationCode: data.code,
          distance: data.km,
          rate15Ton: data.rate15,
          rate20Ton: data.rate20,
          rate30Ton: data.rate30,
        }
      });
    }
  }
  
  for (const data of salaryRatesData) {
    const location = await prisma.location.findFirst({
      where: { name: { equals: data.location, mode: 'insensitive' } }
    });
    
    if (location) {
      await prisma.salaryRate.create({
        data: {
          locationId: location.id,
          locationName: data.location,
          tripAllowance: data.tripAllow,
          driverWages: data.driver,
          motorBoyWages: data.motorBoy,
          totalWages: data.tripAllow + data.driver + data.motorBoy,
        }
      });
    }
  }
}

seedRates().then(() => console.log('Done!')).finally(() => prisma.$disconnect());