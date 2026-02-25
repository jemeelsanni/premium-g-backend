const { NotFoundError, ValidationError } = require('../middleware/errorHandler');
const prisma = require('../lib/prisma');

class TransportPricingService {
  
  // Get haulage rate based on location and truck capacity
  async getHaulageRate(locationId, truckCapacity) {
    const haulageRate = await prisma.haulageRate.findFirst({
      where: {
        locationId,
        isActive: true
      },
      orderBy: {
        effectiveDate: 'desc'
      }
    });

    if (!haulageRate) {
      throw new NotFoundError(`No haulage rate found for location ${locationId}`);
    }

    // Select rate based on truck capacity
    let selectedRate;
    if (truckCapacity <= 15) {
      selectedRate = haulageRate.rate15Ton;
    } else if (truckCapacity <= 20) {
      selectedRate = haulageRate.rate20Ton;
    } else {
      selectedRate = haulageRate.rate30Ton;
    }

    return {
      rate: selectedRate,
      distance: haulageRate.distance,
      haulageRateId: haulageRate.id
    };
  }

  // Get salary rates for location
  async getSalaryRate(locationId) {
    const salaryRate = await prisma.salaryRate.findFirst({
      where: {
        locationId,
        isActive: true
      },
      orderBy: {
        effectiveDate: 'desc'
      }
    });

    if (!salaryRate) {
      // Fallback to location's legacy field
      const location = await prisma.location.findUnique({
        where: { id: locationId }
      });
      
      return {
        tripAllowance: 0,
        driverWages: location?.driverWagesPerTrip || 0,
        motorBoyWages: 0,
        totalWages: location?.driverWagesPerTrip || 0
      };
    }

    return {
      tripAllowance: parseFloat(salaryRate.tripAllowance),
      driverWages: parseFloat(salaryRate.driverWages),
      motorBoyWages: parseFloat(salaryRate.motorBoyWages),
      totalWages: parseFloat(salaryRate.totalWages)
    };
  }

  // Calculate complete trip costs matching your Excel logic
  async calculateTripCosts({
    locationId,
    truckId,
    fuelRequired,
    fuelPricePerLiter,
    additionalExpenses = 0
  }) {
    
    // Get truck details
    const truck = await prisma.truckCapacity.findUnique({
      where: { truckId }
    });

    if (!truck) {
      throw new NotFoundError('Truck not found');
    }

    // 1. Get base haulage rate (TRIP COST from your Excel)
    const { rate: baseHaulageRate } = await this.getHaulageRate(
      locationId, 
      truck.capacity
    );

    // 2. Get salary breakdown
    const salaryBreakdown = await this.getSalaryRate(locationId);

    // 3. Calculate fuel cost (DIESEL TOTAL)
    const totalFuelCost = parseFloat((fuelRequired * fuelPricePerLiter).toFixed(2));

    // 4. Calculate 10% service charge (based on haulage rate, not total)
    const serviceChargePercent = 10.00;
    const serviceChargeExpense = parseFloat(
      ((baseHaulageRate * serviceChargePercent) / 100).toFixed(2)
    );

    // 5. Total trip expenses
    const totalTripExpenses = parseFloat(
      (totalFuelCost + salaryBreakdown.totalWages + serviceChargeExpense + additionalExpenses).toFixed(2)
    );

    // 6. Revenue calculation (matching your Excel formula)
    // REVENUE = TRIP COST - (DIESEL + SALARY + 10% CHARGES + EXPENSES)
    const revenue = parseFloat((baseHaulageRate - totalTripExpenses).toFixed(2));
    const grossProfit = revenue;
    const netProfit = revenue;
    const profitMargin = baseHaulageRate > 0 ? 
      parseFloat(((netProfit / baseHaulageRate) * 100).toFixed(2)) : 0;

    return {
      // Base pricing
      baseHaulageRate: parseFloat(baseHaulageRate),
      totalOrderAmount: parseFloat(baseHaulageRate), // This is the trip cost
      
      // Fuel costs
      fuelRequired: parseFloat(fuelRequired),
      fuelPricePerLiter: parseFloat(fuelPricePerLiter),
      totalFuelCost,
      
      // Salary breakdown
      tripAllowance: salaryBreakdown.tripAllowance,
      driverWages: salaryBreakdown.driverWages,
      motorBoyWages: salaryBreakdown.motorBoyWages,
      totalDriverWages: salaryBreakdown.totalWages,
      
      // Service charge (10%)
      serviceChargePercent,
      serviceChargeExpense,
      
      // Additional expenses
      truckExpenses: parseFloat(additionalExpenses),
      
      // Totals
      totalTripExpenses,
      
      // Profitability
      grossProfit,
      netProfit,
      profitMargin,
      revenue
    };
  }

  // Validate and recalculate existing transport order
  async recalculateTransportOrder(transportOrderId) {
    const order = await prisma.transportOrder.findUnique({
      where: { id: transportOrderId },
      include: {
        truck: true,
        location: true
      }
    });

    if (!order) {
      throw new NotFoundError('Transport order not found');
    }

    const recalculated = await this.calculateTripCosts({
      locationId: order.locationId,
      truckId: order.truckId,
      fuelRequired: order.fuelRequired,
      fuelPricePerLiter: order.fuelPricePerLiter,
      additionalExpenses: order.truckExpenses
    });

    return recalculated;
  }
}

module.exports = new TransportPricingService();