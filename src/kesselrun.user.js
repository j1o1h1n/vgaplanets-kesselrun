// ==UserScript==
// @name        KesselRun
// @author      John Lehmann
// @copyright   John Lehmann, 2024
// @license     Apache 2.0
// @downloadURL http://banksia.local/vgaplanets/kesselrun.user.js
// @description A script for Nu Planets to automate your supply lines
// @namespace   kesselrun/planets.nu
// @include     https://planets.nu/*
// @include     https://*.planets.nu/*
// @include     http://planets.nu/*
// @include     http://*.planets.nu/*
// @require     https://chmeee.org/ext/planets.nu/McNimblesToolkit-1.2.user.js
// @require     https://chmeee.org/ext/planets.nu/FleetManagement.user.js
// @version     1.0
// @grant       none
// ==/UserScript==

if (!GM_info) GM_info = GM.info;

var name = GM_info.script.name;
var version = GM_info.script.version;

var mcntk = vgap.plugins["McNimble's Toolkit"];
var fleet = vgap.plugins["Fleet Management"];

var kesselrun = new mcntk.McNimblesToolkit(name, version);

vgap.registerPlugin(kesselrun, name);
console.log(name + " v"+version+" planets.nu plugin registered");

kesselrun.EPSILON = 1e-6;
kesselrun.MAX_MEGACREDITS = 10000;
kesselrun.MIN_FUEL = 50;

kesselrun.RESOURCES = [
    "megacredits",
    "neutronium",
    "supplies",
    "duranium",
    "tritanium",
    "molybdenum",
];

kesselrun.CARGO_RESOURCES = kesselrun.RESOURCES.slice(-4);

kesselrun.MINERALS = [
    "neutronium",
    "duranium",
    "tritanium",
    "molybdenum",
];

kesselrun.RouteNameEndings = [
    "Run", "Route", "Trail", "Trek", "Leap", "Voyage", "Passage", "Jump", 
    "Expedition", "Corridor", "Pathway", "Drift", "Circuit", "Loop", 
    "Flight", "Track", "Quest", "Chase", "Cruise", "Odyssey", "Expanse", 
    "Journey", "Traverse", "Line", "Detour", "Shortcut", "Way", "March", "Charge",
    "Retreat"
];

class TradeRoute {
    constructor(id, route, targets, assignments) {
        this.id = id;                // Unique ID for the trade route (passed as a parameter)
        this.route = route;          // List of planets in the trade route
        this.targets = targets;      // Map of planet to target resource levels
        this.assignments = assignments; // Map of ship id : current route step

        // Generate a name based on the first and last planet in the route
        const startPlanet = vgap.getPlanet(route[0]).name;      // First planet in the route
        const endPlanet = vgap.getPlanet(route[route.length - 1]).name;  // Last planet in the route

        // Choose a random ending from the list of options
        const ending = kesselrun.RouteNameEndings[Math.floor(Math.random() * kesselrun.RouteNameEndings.length)];

        this.name = `${startPlanet} to ${endPlanet} ${ending}`;  // Auto-generated name
    }
};

class Manifest {
    constructor(supply, demand) {
        this.supply = supply;
        this.demand = demand;
    }
};

kesselrun.zmin = function (...args) {
    return Math.max(0, Math.min(...args));
};

kesselrun.buildManifest = function (tradeRoute) {
    let supply = {};
    let demand = {};

    for (let planetId in tradeRoute.targets) {
        let planet = vgap.getPlanet(planetId);
        if (!planet) continue;

        supply[planetId] = {};
        demand[planetId] = {};
        for (let rsrc in tradeRoute.targets[planetId]) {
            let avail = planet[rsrc];
            let tgt = tradeRoute.targets[planetId][rsrc];
            supply[planetId][rsrc] = Math.max(0, avail - tgt);
            demand[planetId][rsrc] = Math.max(0, tgt - avail);
        }
    }
    return new Manifest(supply, demand);
};

kesselrun.handleUnload = function (ship, planet, demand, supply) {
    for (let rsrc in supply) {
        if (ship[rsrc] === 0) continue;
        let avail = ship[rsrc];
        if (rsrc === "neutronium") {
            if (!vgap.gameUsesFuel()) {
                continue
            }
            let hullId = ship.hullid;
            avail = hullId === 14 ? ship.neutronium : Math.max(ship.neutronium - kesselrun.MIN_FUEL, 0);
        }
        let val = Math.min(avail, demand[rsrc]);
        ship[rsrc] -= val;
        planet[rsrc] += val;
    }
    return true;
};

kesselrun.handleLoadMegacredits = function (ship, planet, supply, mcSpace, totals) {
    if (!supply.megacredits) {
        return true;
    }
    let mc = kesselrun.zmin(supply.megacredits, mcSpace, totals.megacredits);
    ship.megacredits += mc;
    planet.megacredits -= mc;
    return true;
};

kesselrun.handleLoadNeutronium = function (ship, planet, supply, fuelSpace, totals) {
    if (!vgap.gameUsesFuel() || !supply.neutronium) {
        return true;
    }
    let fuel = kesselrun.zmin(supply.neutronium, fuelSpace, totals.neutronium);
    ship.neutronium += fuel;
    planet.neutronium -= fuel;
    return true;
};


kesselrun.handleLoadCargo = function (ship, planet, supply, totals, hullCargo) {
    let totalDemand = kesselrun.CARGO_RESOURCES.reduce((sum, r) => sum + (totals[r] || 0), 0);
    let weights = {};
    let lots = {};

    kesselrun.CARGO_RESOURCES.forEach(r => {
        weights[r] = (totals[r] || 0) / (totalDemand + kesselrun.EPSILON);
        lots[r] = Math.trunc(weights[r] * 10);
    });

    let overflow = 0, last = 0;
    let cargoFree = hullCargo - vgap.getTotalCargo(ship);
    while (overflow < 300) {
        overflow++;
        if (cargoFree === 0 || cargoFree === last) break;
        last = cargoFree;

        kesselrun.CARGO_RESOURCES.forEach(r => {
            let val = kesselrun.zmin(lots[r], supply[r] || 0, totals[r], cargoFree);
            if (val === 0) return;
            ship[r] += val;
            planet[r] -= val;
            supply[r] -= val;
            totals[r] -= val;
            cargoFree = hullCargo - vgap.getTotalCargo(ship);
        });
    }
    return true;
};

kesselrun.handleCargoForShip = function (ship, planet, manifest) {
    const planetId = planet.id;
    ship.changed = 1;

    const hull = vgap.getHull(ship.hullid);
    if (!hull) {
        return false;
    }

    const demand = manifest.demand[planetId];
    const supply = manifest.supply[planetId];
    
    // Calculate total demand for each resource across all planets
    const totals = kesselrun.RESOURCES.reduce((acc, r) => {
        acc[r] = Object.keys(manifest.demand).reduce(
            (sum, p) => sum + (manifest.demand[p][r] || 0),
            0
        );
        return acc;
    }, {});

    if (!kesselrun.handleUnload(ship, planet, demand, supply)) {
        return false;
    }

    const fuelSpace = hull.fueltank - ship.neutronium;
    const mcSpace = kesselrun.MAX_MEGACREDITS - ship.megacredits;
    const hullCargo = hull.cargo;

    return kesselrun.handleLoadMegacredits(ship, planet, supply, mcSpace, totals) &&
          kesselrun.handleLoadNeutronium(ship, planet, supply, fuelSpace, totals) &&
          kesselrun.handleLoadCargo(ship, planet, supply, totals, hullCargo);
};

kesselrun.calcDist = (planetA, planetB) => {
    const dx = planetA.x - planetB.x;
    const dy = planetA.y - planetB.y;
    return Math.sqrt(dx * dx + dy * dy);
};

kesselrun.calcFuel = function (ship, overfill) {
    let dx = ship.targetx - ship.x;
    let dy = ship.targety - ship.y;

    if (dx === 0 && dy === 0) return 0;

    let distance = Math.sqrt(dx * dx + dy * dy);
    if (overfill) {
        distance = Math.max(distance, 81)
    }
    let mass = mcntk.totalMass(ship);
    let engine = vgap.getEngine(ship.engineid);
    return mcntk.fuelForFullDistance(engine, ship.warp, mcntk.isGravitonic(ship), distance, mass);
};

kesselrun.moveToAssigned = function (tradeRoute, ship) {
    const shipId = ship.id;
    const step = tradeRoute.assignments[shipId];
    const assignedId = tradeRoute.route[step % tradeRoute.route.length];
    const assigned = vgap.getPlanet(assignedId);

    if (!assigned) {
        return false;
    }

    ship.targetx = assigned.x;
    ship.targety = assigned.y;
    ship.warp = mcntk.maxWarp(ship);
    return true;
};

kesselrun.setNextDestination = function (tradeRoute, ship) {
    const shipId = ship.id;
    let planet = vgap.planetAt(ship.x, ship.y);
    let step = tradeRoute.assignments[shipId];

    if (!planet || !tradeRoute.route.includes(planet.id)) {
        // Not at planet? Go to assigned planet
        return kesselrun.moveToAssigned(tradeRoute, ship);
    } else {
        let assignedId = tradeRoute.route[step % tradeRoute.route.length];
        if (assignedId === planet.id) {
            // At assigned planet? Update assigned planet, set a waypoint
            tradeRoute.assignments[shipId] += 1;
            return kesselrun.moveToAssigned(tradeRoute, ship);
        } else {
            // At unexpected planet on route? Update assignment to this planet, continue to next step
            for (let i = 0; i < tradeRoute.route.length; i++) {
                step += 1;
                assignedId = tradeRoute.route[step % tradeRoute.route.length];
                if (assignedId === planet.id) {
                    tradeRoute.assignments[shipId] = step + 1;
                    return kesselrun.moveToAssigned(tradeRoute, ship);
                }
            }
        }
    }
    return false;
};

kesselrun.refuel = function (ship) {
    if (!vgap.gameUsesFuel()) {
        return true;
    }
    // If the ship doesn't have enough fuel to get to the next destination, refuel.
    // Return false if there's not enough fuel available.
    const planet = vgap.planetAt(ship.x, ship.y);
    if (!planet || ship.ownerid !== planet.ownerid) return false;

    const cost = kesselrun.calcFuel(ship, false);
    const overfillCost = kesselrun.calcFuel(ship, true);

    const stored = ship.neutronium;
    if (overfillCost <= stored) return true;

    let balance = overfillCost - stored;
    if (planet.neutronium < balance) {
        balance = cost - stored;
        if (planet.neutronium < balance) {
            return false;
        }
    }

    // Refuel from the planet
    ship.neutronium += balance;
    planet.neutronium -= balance;
    return true;
};

kesselrun.updateIdle = function (ship, isReady) {
    ship.readystatus = isReady ? 1 : 0;
    return true;
};

kesselrun.handleRoute = function (tradeRoute) {
    // Adjust the cargo for all ships according to supply and demand.
    for (const shipId in tradeRoute.assignments) {
        const ship = vgap.getShip(shipId);
        if (!ship) continue;

        const planet = vgap.planetAt(ship.x, ship.y);
        if (!planet || tradeRoute.route.indexOf(planet.id) == -1 || ship.ownerid !== planet.ownerid) {
            continue;
        }

        const manifest = kesselrun.buildManifest(tradeRoute);

        kesselrun.updateIdle(
            ship,
            kesselrun.handleCargoForShip(ship, planet, manifest) &&
            kesselrun.setNextDestination(tradeRoute, ship) &&
            kesselrun.refuel(ship)
        );
    }
};

kesselrun.run = function () {
    const tradeRoutes = kesselrun.getTradeRoutes()
    tradeRoutes.forEach(route => kesselrun.handleRoute(route));
};

kesselrun.planetNear = function (cluster, x, y) {
    return cluster.findNearestSphereObjects(x, y, 4)[0]
};

kesselrun.getTradeRoutes = function() {
    // Check if the tradeRoutes setting is defined
    if (typeof kesselrun.settings.tradeRoutes === "undefined") {
        // Create a new persistent game setting if not already defined
        kesselrun.settings.createGameSetting("tradeRoutes", []);
    }
    // Return the tradeRoutes array
    return kesselrun.settings.tradeRoutes();
};

kesselrun.saveTradeRoutes = function(tradeRoutes) {
    kesselrun.settings.setTradeRoutes(tradeRoutes);
};

kesselrun.createTradeRoute = function(route, targets, assignments) {
    // Retrieve the current trade routes
    const tradeRoutes = kesselrun.getTradeRoutes();

    // Determine the highest existing ID and add 1
    const maxId = tradeRoutes.length > 0 ? Math.max(...tradeRoutes.map(tr => tr.id)) : 0;
    const newId = maxId + 1;

    // Create a new TradeRoute instance
    const newTradeRoute = new TradeRoute(newId, route, targets, assignments);

    // Add the new trade route to the list
    tradeRoutes.push(newTradeRoute);

    // Save the updated trade routes back to the settings
    kesselrun.saveTradeRoutes(tradeRoutes);

    return newTradeRoute;
};

// Create a new trade route from the ship waypoints
kesselrun.buildTradeRoute = function (ship) {
    // Get the origin planet based on the ship's current position
    var cluster = new mcntk.EchoCluster(vgap.myplanets)

    let planet = kesselrun.planetNear(cluster, ship.x, ship.y);
    if (!planet) {
        console.warn("No planet at the ship location");
        return;
    }
    const origin = planet.id;
    const route = [planet.id];

    // Get the target planet based on the ship's destination coordinates
    planet = kesselrun.planetNear(cluster, ship.targetx, ship.targety);
    if (!planet) {
        console.warn("No planet at the first ship destination");
        return;
    }
    route.push(planet.id);

    // Process additional waypoints and add them to the route
    ship.waypoints.forEach(wp => {
        planet = kesselrun.planetNear(cluster, wp.x, wp.y);
        if (!planet) {
            console.warn("No planet at a ship waypoint, " + wp.x + ", " + wp.y);
            return;
        }
        route.push(planet.id);
    });

    // Build the targets object, setting resource levels for each planet in the route
    const targets = {};
    route.forEach(planetId => {
        targets[planetId] = {};
        kesselrun.RESOURCES.forEach(rsrc => {
            targets[planetId][rsrc] = (planetId === origin) ? 10000 : 0;
        });
    });

    // Create the initial assignments map for the ship
    const assignments = {};
    assignments[ship.id] = 0;

    // Return a new TradeRoute object
    return kesselrun.createTradeRoute(route, targets, assignments);
};

kesselrun.deleteTradeRoute = function(routeId) {
    // Retrieve the current trade routes
    const tradeRoutes = kesselrun.getTradeRoutes();

    // Filter out the trade route with the specified ID
    const updatedRoutes = tradeRoutes.filter(tr => tr.id !== routeId);

    // Save the updated trade routes back to the settings
    kesselrun.saveTradeRoutes(updatedRoutes);

    return updatedRoutes;
};

kesselrun.copyTradeRoute = function(routeId) {
    // Retrieve the current trade routes
    const tradeRoutes = kesselrun.getTradeRoutes();

    // Find the trade route to copy
    const originalRoute = tradeRoutes.find(tr => tr.id === routeId);
    if (!originalRoute) {
        console.error(`Trade Route with ID ${routeId} not found!`);
        return null;
    }

    // Determine the highest existing ID and add 1
    const maxId = Math.max(...tradeRoutes.map(tr => tr.id));
    const newId = maxId + 1;

    // Create a copy of the original trade route with a new ID
    return kesselrun.createTradeRoute(
        [...originalRoute.route],                   // Clone the route array
        JSON.parse(JSON.stringify(originalRoute.targets)),  // Deep clone targets
        {}                                         // New assignments on the copied route
    )
};

kesselrun.reverseTradeRoute = function(routeId) {
    // Retrieve the current trade routes
    const tradeRoutes = kesselrun.getTradeRoutes();

    // Find the trade route to reverse
    const routeToReverse = tradeRoutes.find(tr => tr.id === routeId);
    if (!routeToReverse) {
        console.error(`Trade Route with ID ${routeId} not found!`);
        return null;
    }

    // Reverse the route array
    const reversedRoute = [...routeToReverse.route].reverse();

    // Create a new reversed trade route using the existing createTradeRoute function
    const reversedTradeRoute = kesselrun.createTradeRoute(
        reversedRoute,             // Reversed route
        routeToReverse.targets,    // Keep the targets unchanged
        {}                         // Empty assignments
    );

    return reversedTradeRoute;
};

kesselrun.updateTradeRouteName = function(routeId, newName) {
    // Retrieve the current trade routes
    const tradeRoutes = kesselrun.getTradeRoutes();

    // Find the trade route to update
    const routeToUpdate = tradeRoutes.find(tr => tr.id === routeId);
    if (!routeToUpdate) {
        console.error(`Trade Route with ID ${routeId} not found!`);
        return false;
    }

    // Update the name of the trade route
    routeToUpdate.name = newName;

    // Save the updated trade routes back to the settings
    kesselrun.saveTradeRoutes(tradeRoutes);

    return true;
};

kesselrun.addPlanetToRoute = function(routeId, newPlanetId, insertionPoint = null) {
    // Retrieve the current trade routes
    const tradeRoutes = kesselrun.getTradeRoutes();

    // Find the trade route to update
    const routeToUpdate = tradeRoutes.find(tr => tr.id === routeId);
    if (!routeToUpdate) {
        console.error(`Trade Route with ID ${routeId} not found!`);
        return false;
    }

    // Insert the new planet at the specified position or append if not provided
    if (insertionPoint !== null && insertionPoint >= 0 && insertionPoint < routeToUpdate.route.length) {
        routeToUpdate.route.splice(insertionPoint, 0, newPlanetId);
    } else {
        // Append the new planet to the end of the route
        routeToUpdate.route.push(newPlanetId);
    }

    // A planet may appear in the route multiple times, but will only have one set of targets
    if (!routeToUpdate.targets.hasOwnProperty(newPlanetId)) {
        routeToUpdate.targets[newPlanetId] = {};
    }

    // Save the updated trade routes back to the settings
    kesselrun.saveTradeRoutes(tradeRoutes);

    return true;
};

kesselrun.modifyTradeRouteTargets = function(routeId, planetId, resourceLevels) {
    // Retrieve the current trade routes
    const tradeRoutes = kesselrun.getTradeRoutes();

    // Find the trade route to update
    const routeToUpdate = tradeRoutes.find(tr => tr.id === routeId);
    if (!routeToUpdate) {
        console.error(`Trade Route with ID ${routeId} not found!`);
        return false;
    }

    // Check if the planet is part of the trade route
    if (!routeToUpdate.route.includes(planetId)) {
        console.error(`Planet with ID ${planetId} is not part of the trade route!`);
        return false;
    }

    // Update the target resource levels for the specified planet
    routeToUpdate.targets[planetId] = { ...resourceLevels };

    // Save the updated trade routes back to the settings
    kesselrun.saveTradeRoutes(tradeRoutes);

    return true;
};

kesselrun.addShipToRoute = function(routeId, shipId) {
    // Retrieve the current trade routes
    const tradeRoutes = kesselrun.getTradeRoutes();

    // Find the trade route to update
    const routeToUpdate = tradeRoutes.find(tr => tr.id === routeId);
    if (!routeToUpdate) {
        console.error(`Trade Route with ID ${routeId} not found!`);
        return false;
    }

    // Retrieve the ship object from vgap
    const ship = vgap.getShip(shipId);
    if (!ship) {
        console.error(`Ship with ID ${shipId} not found!`);
        return false;
    }

    // Remove the ship from any other trade routes before assigning it to the new route
    tradeRoutes.forEach(route => {
        if (route.assignments.hasOwnProperty(shipId)) {
            delete route.assignments[shipId];
        }
    });    

    // Find the nearest planet on the route to assign the ship
    let nearestPlanetId = null;
    let shortestDistance = Number.MAX_VALUE;

    routeToUpdate.route.forEach(planetId => {
        const planet = vgap.getPlanet(planetId);
        if (!planet) return;

        // Calculate the square distance between the ship and the planet
        const dx = planet.x - ship.x;
        const dy = planet.y - ship.y;
        const distance = dx * dx + dy * dy;

        // Update the nearest planet if this one is closer
        if (distance < shortestDistance) {
            shortestDistance = distance;
            nearestPlanetId = planetId;
        }
    });

    if (nearestPlanetId === null) {
        console.error("No valid planets found on the route!");
        return false;
    }

    // Assign the ship to the nearest planet's step in the route
    const stepIndex = routeToUpdate.route.indexOf(nearestPlanetId);
    routeToUpdate.assignments[shipId] = stepIndex;

    // Save the updated trade routes back to the settings
    kesselrun.saveTradeRoutes(tradeRoutes);

    return true;
};

kesselrun.removeShip = function(routeId, shipId) {
    // Retrieve the current trade routes
    const tradeRoutes = kesselrun.getTradeRoutes();

    // Find the trade route to update
    const routeToUpdate = tradeRoutes.find(tr => tr.id === routeId);
    if (!routeToUpdate) {
        console.error(`Trade Route with ID ${routeId} not found!`);
        return false;
    }

    // Check if the ship is assigned to this trade route
    if (!(shipId in routeToUpdate.assignments)) {
        console.warn(`Ship with ID ${shipId} is not assigned to Trade Route ${routeId}.`);
        return false;
    }

    // Remove the ship from the assignments
    delete routeToUpdate.assignments[shipId];

    // Save the updated trade routes back to the settings
    kesselrun.saveTradeRoutes(tradeRoutes);

    return true;
};

kesselrun.movePlanet = function(routeId, index, direction) {
    // Retrieve the current trade routes
    const tradeRoutes = kesselrun.getTradeRoutes();

    // Find the trade route to update
    const tradeRoute = tradeRoutes.find(tr => tr.id === routeId);
    if (!tradeRoute) {
        console.error(`Trade Route with ID ${routeId} not found!`);
        return false;
    }

    // Determine the new index based on the direction ("up" or "down")
    let newIndex = index;
    if (direction === "up" && index > 0) {
        newIndex -= 1;
    } else if (direction === "down" && index < tradeRoute.route.length - 1) {
        newIndex += 1;
    } else {
        console.warn(`Cannot move planet ${direction}. It is already at the ${direction === 'up' ? 'top' : 'bottom'} of the route.`);
        return false;
    }

    // Swap the elements at `index` and `newIndex`
    [tradeRoute.route[index], tradeRoute.route[newIndex]] = [tradeRoute.route[newIndex], tradeRoute.route[index]];
    
    // Save the updated trade routes back to the settings
    kesselrun.saveTradeRoutes(tradeRoutes)

    return true;
};

kesselrun.removePlanet = function(routeId, index) {
    // Retrieve the current trade routes
    const tradeRoutes = kesselrun.getTradeRoutes();

    // Find the trade route to update
    const tradeRoute = tradeRoutes.find(tr => tr.id === routeId);
    if (!tradeRoute) {
        console.error(`Trade Route with ID ${routeId} not found!`);
        return false;
    }

    // Validate index
    if (index < 0 || index >= tradeRoute.route.length) {
        console.error(`Invalid index ${index} for the route!`);
        return false;
    }

    // Get the planet ID at the specified index
    const planetId = tradeRoute.route[index];

    // Remove the planet from the `route` array using the index
    tradeRoute.route.splice(index, 1);

    // Check if the planet ID is still present in the `route` array
    if (!tradeRoute.route.includes(planetId)) {
        // Remove the planet from `targets` if it no longer exists in the route
        delete tradeRoute.targets[planetId];
    }

    // Save the updated trade routes back to the settings
    kesselrun.saveTradeRoutes(tradeRoutes);

    return true;
};

// dialogue functions

kesselrun.dialog = {};  // the dialog attributes

kesselrun.dialog.key = "KR: Dialog";

kesselrun.dialog.allColumns = [
    "ID", "Name", "Pl", "Sh", "Dist",
    "Tgt$", "TgtS", "TgtN", "TgtD", "TgtT", "TgtM",
    "$", "S", "N", "D", "T", "M", "*"
];

kesselrun.dialog.tgtColumns = ["Resource", "Supply", "Target", "Edit"];

// different modal functions

kesselrun.summary = function(object, resource) {
    // object is a trade route
    return kesselrun.availableTargets(object, resource) + " / " + kesselrun.inTransit(object, resource)
}

kesselrun.detail = function(object, resource) {
    // object is a trade route
    let a = kesselrun.alluvial(object, resource)
    let b = ""
    if (kesselrun.MINERALS.includes(resource)) {
        b = "/" + kesselrun.inground(object, resource)
    }
    let c = " (+" + kesselrun.production(object, resource) + ")"
    return a + b + c;
}

kesselrun.availableTargets = function(object, resource) {
    let total = 0;
    for (const planetId in object.targets) {
        const planet = vgap.getPlanet(planetId);
        if (planet && typeof object.targets[planetId][resource] !== 'undefined') {
            // Calculate the difference as `planet[resource] - object.targets[planetId][resource]`
            total += Math.max(0, planet[resource] - (object.targets[planetId][resource] || 0));
        }
    }
    return total;
};

kesselrun.inTransit = function(object, resource) {
    let total = 0;

    // Loop through each ship assigned to the trade route
    for (const assignmentId in object.assignments) {
        // Sum up the resource amount carried by the assigned ships
        total += vgap.getShip(assignmentId)[resource] || 0;
    }

    return total;
};

kesselrun.target = function(object, resource) {
    let planetId = object.id
    return (kesselrun.dialog.parent.targets[planetId] !== undefined && kesselrun.dialog.parent.targets[planetId][resource] !== undefined) 
           ? kesselrun.dialog.parent.targets[planetId][resource] 
           : "n/a";
};

kesselrun.alluvial = function(object, resource) {
    let planetId = object.id
    return object[resource];
};

kesselrun.inground = function(object, resource) {
    let planetId = object.id;
    let value = "0";

    // Check if the `resource` is in the `kesselrun.MINERALS` array
    if (kesselrun.MINERALS.includes(resource)) {
        value = object["ground" + resource];
    }
    
    return value;
};

kesselrun.production = function(object, resource) {
    let planetId = object.id;
    let value = "-";

    if (resource === "megacredits") {
        value = Math.min(5000, vgap.nativeTaxAmount(object) + vgap.colonistTaxAmount(object));
    } else if (resource === "supplies") {
        value = vgap.pl.totalSuppliesOutput(object)
    } else if (kesselrun.MINERALS.includes(resource)) {
        value = vgap.miningAmount(object, object["ground" + resource], object["density" + resource], object.mines) 
    }
    
    return value;
};

kesselrun.modeDefinitions = {
    "summary": {fun: kesselrun.summary,
                buttons: ["Add Route"],
                help: "Available over target / In transit in ships"},
    "planets": {fun: kesselrun.detail,
                buttons: ["Ships", "Add Ship", "Add Planet", "\u23CE"],
                help: "Showing Target and Available/Ground/(Production)"},
    "addplanet": {fun: kesselrun.detail,
                buttons: [],
                help: "Select planet to add to trade route"},
    "targets": {fun: kesselrun.detail,
                buttons: ["\u23CE"],
                help: "Edit planet targets"},

};


// dialog creation
kesselrun.showPlanetTargetsDialog = function (planet) {
    const tradeRoute = kesselrun.dialog.parent;
    const parent = [tradeRoute, planet]
    const targets = kesselrun.RESOURCES;
    const cols = kesselrun.dialog.tgtColumns
    kesselrun.createDialog("targets", [tradeRoute, planet], targets, cols, null,
                           "[P"+ planet.id + "] " + planet.name + " Targets");
};


kesselrun.showTradeRouteDetail = function (tradeRoute) {
    const planets = tradeRoute.route.map(planetId => vgap.getPlanet(planetId));
    let cols = kesselrun.dialog.allColumns.filter(column => column !== "Pl" && column !== "Sh");
    kesselrun.createDialog("planets", tradeRoute, planets, cols, 
                           kesselrun.showPlanetTargetsDialog,
                           "["+ tradeRoute.id + "] " + tradeRoute.name + " Planets");
};

kesselrun.showTradeRoutes = function () {
    const tradeRoutes = kesselrun.getTradeRoutes();
    let cols = kesselrun.dialog.allColumns.filter(column => !column.startsWith("Tgt") && column !== "*");
    cols.push("\u2600");
    kesselrun.createDialog("summary", null, tradeRoutes, cols, 
                           kesselrun.showTradeRouteDetail, "Trade Routes");
};

kesselrun.dialog.popDialog = function () {
    if (kesselrun.dialog.mode === "planets") {
        kesselrun.showTradeRoutes();
    } else if (kesselrun.dialog.mode === "targets") {
        const parent = kesselrun.dialog.parent;
        const tradeRoute = parent[0];
        kesselrun.showTradeRouteDetail(tradeRoute);
    }
}

kesselrun.createDialog = function(mode, parent, targets, columns, fun, title) {
    kesselrun.dialog.parent = parent;
    kesselrun.dialog.targets = targets;
    kesselrun.dialog.columns = columns;
    kesselrun.dialog.mode = mode
    kesselrun.dialog.modeFun = kesselrun.modeDefinitions[mode].fun;
    kesselrun.dialog.modeHelp = kesselrun.modeDefinitions[mode].help;
    kesselrun.dialog.buttons = kesselrun.modeDefinitions[mode].buttons;
    kesselrun.dialog.selectedFun = fun;

    var table = kesselrun.createTable(targets);
    nu.keyedmodal(kesselrun.dialog.key, table, title, 1200, "body");

    var modal = nu.keyedmodals[kesselrun.dialog.key];
    modal.css('width', 'unset');
    modal.center();
    var top = modal.css('top').match(/(.+)px/)[1];
    if (top < 0) modal.css('top', 0);

    // works for both desktop and mobile ;)
    $("#KRTable").parent().css({"background-image": "none", "background": "black"});  
}

kesselrun.createTable = function(targets) {
    var table = $("<table class='KRTradeRoutes' id='KRTable'></table>");
    kesselrun.fillTable(table, targets);
    return table;
}

kesselrun.updateTable = function() {
    var table = $("#KRTable");
    table.empty();
    if (kesselrun.dialog.mode == "summary") {
        kesselrun.dialog.targets = kesselrun.getTradeRoutes();
    } else if (kesselrun.dialog.mode == "planets") {
        const routeId = kesselrun.dialog.parent.id
        const tradeRoute = kesselrun.getTradeRoutes().find(tr => tr.id === routeId);
        const planets = tradeRoute.route.map(planetId => vgap.getPlanet(planetId));
        kesselrun.dialog.parent = tradeRoute;
        kesselrun.dialog.targets = planets;
    }
    kesselrun.fillTable(table, kesselrun.dialog.targets);
}

kesselrun.fillTable = function(table, targets) {
    table.append(kesselrun.renderTargetHeader());
    kesselrun.addRows(table, targets);
    table.append(kesselrun.helpRow(table));
    table.append(kesselrun.editRow(table));
}

kesselrun.renderTargetHeader = function() {
    var row = $("<tr></tr>");

    kesselrun.dialog.columns.forEach((header) => {
        var col = kesselrun.columnDefinitions[header];
        kesselrun.createHeader(row, header, col.fun);
    });
    return row;
}

kesselrun.createHeader = function(row, label, fun) {
    const header = $("<th>"+label+"</th>");
    const tt = kesselrun.columnDefinitions[label].tt
    header.attr("title", tt);
    header.tclick(function() {
        kesselrun.towTargets.sort(function(lhs, rhs) {
            var valA = fun(lhs),
                valB = fun(rhs);
            if (valA > valB) return 1;
            if (valA < valB) return -1;
            return 0;
        });
        kesselrun.updateTable();
    });
    row.append(header);
}

kesselrun.addRows = function(table, targets) {
    targets.forEach((target, idx) => {
        var row = kesselrun.renderTarget(target, idx);
        // Create a fixed scope for the target
        var fixedScopeTarget = target;
        // Set up the click handler
        row.tclick(function() { kesselrun.success(fixedScopeTarget); });
        // Append the row to the table
        table.append(row);
    });
};

kesselrun.helpRow = function(table) {
    let row = $("<tr/>");
    row.css("color", "orange");
    // spacer cell
    row.append($("<td></td>"));
    let help = $("<td id='KRTableHelp' colspan=9></td>");
    help.text(kesselrun.dialog.modeHelp)
    row.append(help);
    table.append(row)
};

// Add a route from a ship
kesselrun.addRoute = function () {
    const shipSelectedFunc = function (ignore, ship) {
        kesselrun.buildTradeRoute(ship);
        kesselrun.updateTable();
    }
    var ships = vgap.myships.filter(ship => !(ship.x === ship.targetx && ship.y === ship.targety));

    fleet.createDialog(null, ships, fleet.allColumns, shipSelectedFunc, "Create Trade Route From Ship Waypoints")
}

// Ship assigned ships, click to unassign
kesselrun.showShipsDialog = function () {
    const shipSelectedFunc = function (ignore, ship) {
        const tradeRouteId = kesselrun.dialog.parent.id;
        kesselrun.removeShip(tradeRouteId, ship.id);
        kesselrun.updateTable();
    };
    const tradeRoutes = kesselrun.getTradeRoutes();
    const tradeRouteId = kesselrun.dialog.parent.id;
    const tradeRoute = tradeRoutes.find(tr => tr.id === tradeRouteId);
    let ships = vgap.myships.filter(ship => tradeRoute.assignments.hasOwnProperty(ship.id));
    fleet.createDialog(null, ships, fleet.allColumns, shipSelectedFunc, "Click to unassign ship");
}

// Select a ship to add to the trade route
kesselrun.addShipDialog = function () {
    const shipSelectedFunc = function (ignore, ship) {
        const tradeRouteId = kesselrun.dialog.parent.id;
        kesselrun.addShipToRoute(tradeRouteId, ship.id);
        kesselrun.updateTable();
    };
    const tradeRoutes = kesselrun.getTradeRoutes();
    const tradeRouteId = kesselrun.dialog.parent.id;
    const tradeRoute = tradeRoutes.find(tr => tr.id === tradeRouteId);
    let ships = vgap.myships.filter(ship => !tradeRoute.assignments.hasOwnProperty(ship.id));
    fleet.createDialog(null, ships, fleet.allColumns, shipSelectedFunc, "Click to add ship to trade route");
}

kesselrun.addPlanetDialog = function () {
    const callback = function (planet) {
        const tradeRoute = kesselrun.dialog.parent
        kesselrun.addPlanetToRoute(tradeRoute.id, planet.id);
        const updatedTradeRoute = kesselrun.getTradeRoutes().find(tr => tr.id == tradeRoute.id);
        kesselrun.showTradeRouteDetail(updatedTradeRoute);
    };

    // Filter out unwanted columns
    const cols = kesselrun.dialog.allColumns.filter(column => 
        !column.startsWith("Tgt") && column !== "*" && column !== "Pl" && column !== "Sh"
    );
    // select from all planets
    const planets = vgap.myplanets;
    kesselrun.createDialog("addplanet", kesselrun.dialog.parent, planets, cols, callback, 
                           "Click to add planet to trade route");
};

// add the bottom row edit buttons
kesselrun.editRow = function(table) {
    const row = $("<tr align='right'/>");
    row.css("color", "#81f7e5");
    const cell = $("<td colspan='" + kesselrun.dialog.columns.length + "''></td>")
    kesselrun.dialog.buttons.forEach(name => {
        const tt = kesselrun.buttonDefinitions[name].tt;
        const fun = kesselrun.buttonDefinitions[name].fun;

        const btn = $("<div/>");
        btn.text(name);
        btn.addClass('smallbutton');
        btn.attr('title', tt);
        btn.on("click", fun);

        cell.append(btn);
    });
    row.append(cell)
    table.append(row)
};

kesselrun.success = function(target) {
    if (kesselrun.dialog.selectedFun) {
        nu.closekeyedmodal(kesselrun.dialog.key);
        kesselrun.dialog.selectedFun(target);
    }
};

kesselrun.renderTarget = function(object, objectIdx) {
    var row = $("<tr/>");
    row.css("color", kesselrun.colorFor(object));

    // Use the index parameter in the forEach loop
    kesselrun.dialog.columns.forEach(header => {
        var col = kesselrun.columnDefinitions[header];
        let td = $("<td/>");
        td.append(col.fun(object, objectIdx));
        row.append(td);
    });

    return row;
};

kesselrun.colorFor = function(object) {
    return "green";
};

// column functions

kesselrun.dialog.id = function(object) {
    return object.id;
};

kesselrun.dialog.name = function(object) {
    return object.name;
};

kesselrun.dialog.planets = function(object) {
    return object.route.length;
};

kesselrun.dialog.ships = function(object) {
    return Object.keys(object.assignments).length;
};

kesselrun.dialog.dist = function(object) {
    warpFun = function(d) {
        let w = Math.ceil(Math.sqrt(d));
        return (w<=9) ? w : "!"
    }

    if (object.route) {
        // If the object is a trade route, calculate the total distance between all planets on the route
        let total = 0;
        let maxHop = 0;
        for (let i = 0; i < object.route.length; i++) {
            const planetA = vgap.getPlanet(object.route[i]);
            const planetB = vgap.getPlanet(object.route[(i + 1) % object.route.length]);
            const dist = kesselrun.calcDist(planetA, planetB)
            maxHop = Math.max(maxHop, dist);
            total += dist;
        }
        let warp = warpFun(maxHop)
        return Math.ceil(total) + " (" + warp + ")";
    } else {
        // If the object is a planet, calculate the distance to the next planet on the route
        const tradeRoute = kesselrun.dialog.parent;
        const planetId = object.id;  // The current planet's ID
        const index = tradeRoute.route.indexOf(planetId);
        const nextPlanetId = tradeRoute.route[(index + 1) % tradeRoute.route.length]
        const planetB = vgap.getPlanet(nextPlanetId)
        const dist = kesselrun.calcDist(object, planetB);
        const warp = warpFun(dist);
        return Math.ceil(dist) + " (" + warp + ")";
    }
};

kesselrun.dialog.tgtMegacredits = function(object) {
    return kesselrun.target(object, "megacredits");
};

kesselrun.dialog.tgtNeutronium = function(object) {
    return kesselrun.target(object, "neutronium");
};

kesselrun.dialog.tgtSupplies = function(object) {
    return kesselrun.target(object, "supplies");
};

kesselrun.dialog.tgtTritanium = function(object) {
    return kesselrun.target(object, "tritanium");
};

kesselrun.dialog.tgtDuranium = function(object) {
    return kesselrun.target(object, "duranium");
};

kesselrun.dialog.tgtMolybdenum = function(object) {
    return kesselrun.target(object, "molybdenum");
};

kesselrun.dialog.megacredits = function(object) {
    return kesselrun.dialog.modeFun(object, "megacredits");
};

kesselrun.dialog.neutronium = function(object) {
    return kesselrun.dialog.modeFun(object, "neutronium");
};

kesselrun.dialog.supplies = function(object) {
    return kesselrun.dialog.modeFun(object, "supplies");
};

kesselrun.dialog.tritanium = function(object) {
    return kesselrun.dialog.modeFun(object, "tritanium");
};

kesselrun.dialog.duranium = function(object) {
    return kesselrun.dialog.modeFun(object, "duranium");
};

kesselrun.dialog.molybdenum = function(object) {
    return kesselrun.dialog.modeFun(object, "molybdenum");
};

kesselrun.dialog.editPlanetList = function(object, index) {
    const route = kesselrun.dialog.parent.route;

    // Check if the planet is at the top or bottom of the route
    const top = index == 0;
    const bottom = index == (route.length - 1);

    // Create a new div container
    const div = $("<div/>");

    // Create the 'Up' button
    const btnUp = $("<div class='smallbutton' label='Move Up'>\u2191</div>");
    
    // Create the 'Down' button
    const btnDown = $("<div class='smallbutton' label='Move Down'>\u2193</div>");
    
    // Create the 'Remove' button
    const btnRemove = $("<div class='smallbutton' label='Remove'>\u274c</div>");

    btnUp.on("click", function () { 
        kesselrun.movePlanet(kesselrun.dialog.parent.id, index, "up"); 
        kesselrun.updateTable(); 
    });

    btnDown.on("click", function () { 
        kesselrun.movePlanet(kesselrun.dialog.parent.id, index, "down"); 
        kesselrun.updateTable(); 
    });

    btnRemove.on("click", function () { 
        kesselrun.removePlanet(kesselrun.dialog.parent.id, index); 
        kesselrun.updateTable(); 
    });

    if (top) {
        btnUp.css("visibility", "hidden");
    }

    if (bottom) {
        btnDown.css("visibility", "hidden");
    }

    if (route.length == 1) {
        btnRemove.css("visibility", "hidden");
    }

    // Append the buttons to the container
    div.append(btnUp);
    div.append(btnDown);
    div.append(btnRemove);

    return div;
};

kesselrun.dialog.editTradeRoutesList = function(object, index) {
    const div = $("<div/>");
    const btnRemove = $("<div class='smallbutton' label='Delete'>\u274c</div>");

    btnRemove.on("click", function () { 
        kesselrun.dialog.targets = kesselrun.deleteTradeRoute(object.id)
        kesselrun.updateTable(); 
    });

    // Append the buttons to the container
    div.append(btnRemove);
    return div;
};

// functions for edit planet target

kesselrun.dialog.resource = function(resource) {
    return resource.charAt(0).toUpperCase() + resource.slice(1).toLowerCase();;
};

kesselrun.dialog.supply = function(resource) {
    const parent = kesselrun.dialog.parent;
    const planet = parent[1];
    return kesselrun.detail(planet, resource);
};

kesselrun.dialog.target = function(resource) {
    const parent = kesselrun.dialog.parent;
    const tradeRoute = parent[0];
    const planetId = parent[1].id;
    return tradeRoute.targets?.[planetId]?.[resource] ?? "n/a"
};

kesselrun.dialog.editTargets = function(resource) {
    const parent = kesselrun.dialog.parent;
    const tradeRoute = parent[0];
    const planetId = parent[1].id;
    let val = tradeRoute.targets?.[planetId]?.[resource] ?? 0

    // Create a new div container
    const div = $("<div/>");

    const deltas = [1000, 100, 10, 1, 0, -1, -10, -100, -1000];
    deltas.forEach( delta => {
        const text = (delta == 0 ? "" : delta > 0 ? "\u2191" : "\u2193") + Math.abs(delta);
        const btn = $("<div class='smallbutton'/>");
        btn.text(text)
        btn.tclick(function() {
            if (delta == 0) {
                tradeRoute.targets[planetId][resource] = 0;
            } else {
                tradeRoute.targets[planetId][resource] = Math.max(0, val + delta);
            }
            kesselrun.modifyTradeRouteTargets(tradeRoute.id, planetId, tradeRoute.targets[planetId]);
            kesselrun.updateTable(); 
        });
        div.append(btn);
    })
    // TODO delete button
    return div;
};


kesselrun.columnDefinitions = {
    "ID": { fun: kesselrun.dialog.id, tt: "Trade Route ID" },
    "Name": { fun: kesselrun.dialog.name, tt: "Trade Route Name" },
    "Pl": { fun: kesselrun.dialog.planets, tt: "Number of Planets" },  // Planets
    "Sh": { fun: kesselrun.dialog.ships, tt: "Number of Ships" },     // Ships
    "Dist": { fun: kesselrun.dialog.dist, tt: "Distance to next planet (Warp)" },
    "Tgt$": { fun: kesselrun.dialog.tgtMegacredits, tt: "Target Megacredits" },
    "TgtS": { fun: kesselrun.dialog.tgtSupplies, tt: "Target Supplies" },
    "TgtN": { fun: kesselrun.dialog.tgtNeutronium, tt: "Target Neutronium" },
    "TgtD": { fun: kesselrun.dialog.tgtDuranium, tt: "Target Duranium" },
    "TgtT": { fun: kesselrun.dialog.tgtTritanium, tt: "Target Tritanium" },
    "TgtM": { fun: kesselrun.dialog.tgtMolybdenum, tt: "Target Molybdenum" },
    "$": { fun: kesselrun.dialog.megacredits, tt: "Megacredits" },
    "S": { fun: kesselrun.dialog.supplies, tt: "Supplies" },
    "N": { fun: kesselrun.dialog.neutronium, tt: "Neutronium" },
    "D": { fun: kesselrun.dialog.duranium, tt: "Duranium" },
    "T": { fun: kesselrun.dialog.tritanium, tt: "Tritanium" },
    "M": { fun: kesselrun.dialog.molybdenum, tt: "Molybdenum" },
    "*": { fun: kesselrun.dialog.editPlanetList, tt: "Move Up/Down/Delete"},
    "\u2600": { fun: kesselrun.dialog.editTradeRoutesList, tt: "Delete"},
    // planet target columns
    "Resource": { fun: kesselrun.dialog.resource, tt: "Resource"},
    "Supply": { fun: kesselrun.dialog.supply, tt: "Avail./In-ground (Prod.)"},
    "Target": { fun: kesselrun.dialog.target, tt: "Target Amount"},
    "Edit": { fun: kesselrun.dialog.editTargets,  tt: "Edit Target Amount"},
};

kesselrun.buttonDefinitions = {
    "Add Route": { fun: kesselrun.addRoute, tt: "Add a new route from a ship waypoints" },
    "Ships": { fun: kesselrun.showShipsDialog, tt: "Show ships assgined to trade route"},
    "Add Ship": { fun: kesselrun.addShipDialog, tt: "Add a ship to the trade route"},
    "Add Planet": { fun: kesselrun.addPlanetDialog, tt: "Add a planet to the trade route"},
    "\u23CE": { fun: kesselrun.dialog.popDialog, tt: "Return"}
};

mcntk.addMcNTkMenuEntry({
    // f04b - play icon from font-awesome
    label: mcntk.onMobile() ? "\uf04b" : "Run Trade Routes",
    fontClass: "fas",
    name: "Run Trade Routes",
    color: "#81f7e5",
    state: () => { return false; },
    action: kesselrun.run
});

mcntk.addMcNTkMenuEntry({
    // f279 - map icon from font-awesome
    label: mcntk.onMobile() ? "\uf279" : "Show Trade Routes",
    fontClass: "fas",
    name: "Show Trade Routes",
    color: "#fca311",
    state: () => { return false; },
    action: kesselrun.showTradeRoutes
});

// Styling

var head = document.getElementsByTagName('head')[0];
if (head) {
    var newCss = document.createElement('style');
    newCss.type = "text/css";
    newCss.innerHTML =
        "table.KRTradeRoutes { margin: 0px; }  " +  // Reduce spacing to put more ships on the screen
        "table.KRTradeRoutes th { padding: 10px 2px; }  " +  // take out some horizontal padding for easier fitting on the screen
        "table.KRTradeRoutes tr td { padding: 0px 0.5ex; border: 0px; }  " +  // Reduce spacing to put more ships on the screen
        "section.popup { max-width: 95%; }"  // Allow wide popup for our fleet
    head.appendChild(newCss);
}
