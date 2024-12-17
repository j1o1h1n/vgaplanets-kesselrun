// ==UserScript==
// @name        KesselRun
// @author      John Lehmann
// @copyright   John Lehmann, 2024
// @license     Apache 2.0
// @downloadURL https://www.helianthi.com/listings/kesselrun.user.js
// @description A script for Nu Planets to automate your supply lines
// @namespace   kesselrun/planets.nu
// @include     https://planets.nu/*
// @include     https://*.planets.nu/*
// @include     http://planets.nu/*
// @include     http://*.planets.nu/*
// @require     https://chmeee.org/ext/planets.nu/McNimblesToolkit-1.2.user.js
// @require     https://chmeee.org/ext/planets.nu/FleetManagement.user.js
// @version     1.2
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
kesselrun.READY_COLOR = "fca311";
kesselrun.NOT_READY_COLOR = "81f7e5";

kesselrun.pri_colors = ["#C75226", "#2639C7", "#268EC7", "#C7203C", "#8F65A3"];
kesselrun.sec_colors = ["#CA8569", "#3C4272", "#3C5F72", "#BD5264", "#8F65A3"];

kesselrun.RESOURCES = [
    "megacredits",
    "neutronium",
    "supplies",
    "clans",
    "duranium",
    "tritanium",
    "molybdenum",
];

kesselrun.CARGO_RESOURCES = kesselrun.RESOURCES.slice(-5);

kesselrun.MINERALS = [
    "neutronium",
    "duranium",
    "tritanium",
    "molybdenum",
];

kesselrun.METALS = [
    "duranium",
    "tritanium",
    "molybdenum",
];

kesselrun.RouteNameEndings = [
    "Run", "Route", "Trail", "Trek", "Leap", "Voyage", "Passage", "Jump", 
    "Expedition", "Corridor", "Pathway", "Drift", "Circuit", "Loop", 
    "Flight", "Track", "Quest", "Chase", "Cruise", "Odyssey", "Expanse", 
    "Journey", "Traverse", "Line", "Detour", "Shortcut", "Way", "March", "Charge",
];

kesselrun.UnitaryRouteNameEndings = ["Stand", "Stop", "Terminus", "Pond",
    "Pasture", "Paddock", "End", "Retreat", "Farm", "Ranch"];

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
        const unitaryEnding = kesselrun.UnitaryRouteNameEndings[Math.floor(Math.random() * kesselrun.UnitaryRouteNameEndings.length)];

        // Auto-generate the route name
        this.name = route.length > 1 ? `${startPlanet} to ${endPlanet} ${ending}` : `${startPlanet} ${unitaryEnding}`;
    }
};

class MinPriorityQueue {
    constructor() {
        this.items = [];
    }

    enqueue(element, priority) {
        this.items.push({ element, priority });
        this.items.sort((a, b) => a.priority - b.priority);  // Sort by priority
    }

    dequeue() {
        return this.items.shift();  // Remove and return the element with the smallest priority
    }

    isEmpty() {
        return this.items.length === 0;
    }
};

/**
 * Return zero bounded minimum.
 */
kesselrun.zmin = function (...args) {
    return Math.max(0, Math.min(...args));
};

/**
 * An object with supply and demand tables by planet, for a trade route.
 * {"supply": {planetId: {rsrc: qty}}, "demand": {planetId: {rsrc: qty}}}
 */
class Manifest {
    constructor(supply, demand) {
        this.supply = supply;
        this.demand = demand;
    }
};

/**
 * Builds and returns a Manifest of supply and demand for a trade route.
 *
 * @param {Object} tradeRoute - The trade route object containing planet targets.
 * @returns {Manifest} - A Manifest object with supply and demand tables by planet.
 *
 * For single-stop (alchemy) routes, it directly maps available resources to supply and demand.
 * For multi-stop routes, it calculates supply and demand based on the difference 
 * between available resources and targets.
 */
kesselrun.buildManifest = function (tradeRoute) {
    const onestop = tradeRoute.route.length == 1;
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
            if (onestop) {
                // tweak to cause Merlin & Alchemy to load supplies on a single planet route
                supply[planetId][rsrc] = avail;
                demand[planetId][rsrc] = tgt;
            } else {
                supply[planetId][rsrc] = Math.max(0, avail - tgt);
                demand[planetId][rsrc] = Math.max(0, tgt - avail);
            }
        }
    }
    return new Manifest(supply, demand);
};

/**
 * Build a matrix of the transwarp navigable distances between planets in the trade route.
 */
kesselrun.buildDistanceMatrix = function(tradeRoute) {
    const matrix = {};

    // Step 1: Calculate distances between all pairs, excluding pairs with distance > 83
    for (let i = 0; i < tradeRoute.route.length; i++) {
        const a = vgap.getPlanet(tradeRoute.route[i]);
        if (!matrix[a.id]) matrix[a.id] = {};
        
        for (let j = i + 1; j < tradeRoute.route.length; j++) {
            const b = vgap.getPlanet(tradeRoute.route[j]);
            const dist = kesselrun.calcDist(a, b);
            if (dist > 83) continue;  // Skip overlong distances
            
            matrix[a.id][b.id] = dist;
            if (!matrix[b.id]) matrix[b.id] = {};
            matrix[b.id][a.id] = dist;  // Symmetry
        }
    }

    // Step 2: Add/overwrite distances for adjacent pairs (wrap around using modulo)
    for (let i = 0; i < tradeRoute.route.length; i++) {
        const a = vgap.getPlanet(tradeRoute.route[i]);
        const next = (i + 1) % tradeRoute.route.length;
        const b = vgap.getPlanet(tradeRoute.route[next]);
        const dist = kesselrun.calcDist(a, b);

        matrix[a.id][b.id] = dist;
        matrix[b.id][a.id] = dist;  // Symmetry
    }

    return matrix;
};

kesselrun.isFullyLoaded = function (ship) {
    const hull = vgap.getHull(ship.hullid);
    const loading = vgap.getTotalCargo(ship) / hull.cargo;
    return loading > 0.95;
};

kesselrun.handleUnload = function (ship, planet, demand, supply) {
    if (ship.hullid == 104 && vgap.gameUsesFuel()) {
        // 104 - refinery - unload all but 1 fuel
        let val = ship.neutronium - 1;
        ship.neutronium -= val;
        planet.neutronium += val;
    } else if (ship.hullid == 105) {
        // 105 - merlin - unload all minerals
        for (let rsrc of kesselrun.METALS) {
            planet[rsrc] += ship[rsrc];
            ship[rsrc] = 0;            
        }
    } else {
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

/**
 * Loads cargo onto the ship based on available supply, total demand, and ship capacity.
 *
 * The function filters available resources, calculates how much of each to load based on
 * demand and cargo space, and updates the ship, planet, and supply objects accordingly.
 */
kesselrun.handleLoadCargo = function (ship, planet, supply, totals, hullCargo) {
    let resources = kesselrun.CARGO_RESOURCES.filter(r => ((supply[r] || 0) > 0) && ((totals[r] || 0) > 0))
    let totalDemand = resources.reduce((sum, r) => sum + (totals[r] || 0), 0);
    let weights = {};
    let lots = {};

    resources.forEach(r => {
        weights[r] = (totals[r] || 0) / (totalDemand + kesselrun.EPSILON);
        lots[r] = Math.trunc(weights[r] * 10);
    });

    let overflow = 0, last = 0;
    let cargoFree = hullCargo - vgap.getTotalCargo(ship);
    while (overflow < 300) {
        overflow++;
        if (cargoFree === 0 || cargoFree === last) break;
        last = cargoFree;

        resources.forEach(r => {
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

kesselrun.calcDist = (lhs, rhs) => {
    return Math.dist(lhs.x, lhs.y, rhs.x, rhs.y);
};

kesselrun.calcFuel = function (ship, overfill) {
    let distance = Math.dist(ship.x, ship.y, ship.targetx, ship.targety);
    if (overfill) {
        distance = Math.max(distance, 81)
    }
    let mass = mcntk.totalMass(ship);
    let engine = vgap.getEngine(ship.engineid);
    return mcntk.fuelForFullDistance(engine, ship.warp, mcntk.isGravitonic(ship), distance, mass) + 1;
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
    ship.warp = Math.min(mcntk.maxWarp(ship), ship.engineid);
    return true;
};

/**
 * Move to the next planet in the trade route, in the normal order.
 */
kesselrun.followTradeRoute = function (tradeRoute, ship) {
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

/**
 * Use Dijkstra search to find the shortest path from startPlanet to targetPlanet
 * and return the next destination, given startPlanet as the starting point.
 */
kesselrun.search = function (graph, startPlanet, targetPlanet) {
    let backtrack = {};
    let distances = {};
    
    // Initialize distances to infinity for all nodes
    for (const node in graph) {
        distances[node] = Infinity;
    }
    distances[startPlanet] = 0;

    // Priority queue of unvisited nodes
    let unvisited = new MinPriorityQueue();
    unvisited.enqueue(startPlanet, 0);

    while (!unvisited.isEmpty()) {
        let { element: currentNode, priority: currentDistance } = unvisited.dequeue();

        if (currentDistance > distances[currentNode]) {
            continue;
        }

        // Explore neighbors
        for (const [neighbor, weight] of Object.entries(graph[currentNode])) {
            let distance = currentDistance + weight;    
            if (distance < distances[neighbor]) {
                distances[neighbor] = distance;
                unvisited.enqueue(neighbor, distance);
                backtrack[neighbor] = currentNode;
            }
        }
    }

    // Reconstruct the path from targetPlanet back to startPlanet using the backtrack map
    let nextPlanet = targetPlanet;
    while (backtrack[nextPlanet] !== startPlanet) {
        nextPlanet = backtrack[nextPlanet];
    }

    // return the next stop
    return nextPlanet;
}

/**
 * Move by the shortest path to the next planet where there is demand for what the
 * ship is carrying.
 */
kesselrun.followDemand = function (tradeRoute, manifest, currentPlanet, ship) {
    // find nearest planet with demand for the ship cargo
    let targetPlanet = null;
    let minDistance = Infinity;
    for (const planetId in manifest.demand) {
        if (planetId == currentPlanet.id) continue;  // Skip the current planet

        const planetDemand = manifest.demand[planetId];
        let hasDemand = kesselrun.CARGO_RESOURCES.some(resource => 
            planetDemand[resource] > 0 && ship[resource] > 0
        );

        if (!hasDemand) {
            continue;
        }

        const planet = vgap.getPlanet(planetId);
        const distance = kesselrun.calcDist(currentPlanet, planet);
        if (distance < minDistance) {
            minDistance = distance;
            targetPlanet = planet;
        }
    }
    if (!targetPlanet) {
        return false;
    }

    // find the shortest path to the targetPlanet
    let graph = kesselrun.buildDistanceMatrix(tradeRoute);
    let nextPlanetId = kesselrun.search(graph, currentPlanet.id, targetPlanet.id);

    console.log("followDemand: ship " + ship.id + " is fully loaded will move to " + targetPlanet.id + " via " + nextPlanetId)

    // update the assignment to the next planet on the path and moveToAssigned
    let step = tradeRoute.assignments[ship.id];
    for (let i = 0; i < tradeRoute.route.length; i++) {
        step = (step + 1) % tradeRoute.route.length;
        if (tradeRoute.route[step] === nextPlanetId) {
            tradeRoute.assignments[ship.id] = step;
            return kesselrun.moveToAssigned(tradeRoute, ship);
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
        if (!planet || !tradeRoute.route.includes(planet.id) || ship.ownerid !== planet.ownerid) {
            continue;
        }

        const manifest = kesselrun.buildManifest(tradeRoute);

        // single-stop route - no need to move
        if (tradeRoute.route.length == 1) {
            kesselrun.updateIdle(ship, kesselrun.handleCargoForShip(ship, planet, manifest));
            continue;
        }

        // Load cargo, then if fully loaded, head to the next planet with demand for the ship's cargo.
        // Otherwise, follow the next step on the trade route.
        let ready = kesselrun.handleCargoForShip(ship, planet, manifest)
                    && ((kesselrun.isFullyLoaded(ship) && kesselrun.followDemand(tradeRoute, manifest, planet, ship))
                         || kesselrun.followTradeRoute(tradeRoute, ship))
                    && kesselrun.refuel(ship);

        // Update idle status based on readiness.
        kesselrun.updateIdle(ship, ready);
    }
};


kesselrun.updateShipNotes = function (ready) {
    let routes = kesselrun.getTradeRoutes();
    routes.forEach(route => {
        Object.keys(route.assignments).forEach(shipId => {
            let note = vgap.getShipNote(shipId);
            let colors = kesselrun.pri_colors;
            let color = !ready ? colors[route.id % colors.length].substring(1) : kesselrun.READY_COLOR;

            note.body = "TR" + route.id;
            note.color = color;
            note.changed = 1;
        });
    });
};

kesselrun.drawTradeRoutes = function (tradeRoutes) {
    const zmin = 1;
    const zmax = 30;
    const overlays = vgap.map.drawingtool.overlays;
    const layer = {
        "active": true,
        "name": "Trade Routes",
        "markups": []
    };
    let count = 0;

    for (let tradeRoute of tradeRoutes) {
        if (tradeRoute.route.length == 1) {
            continue;
        }
        for (let offset of [0, 1]) {
            let colors = offset == 0 ? kesselrun.pri_colors : kesselrun.sec_colors;
            let color = colors[tradeRoute.id % colors.length];
            let markup = {"type": "line", "points": [], "attr": {"stroke": color, "color": color, "zmin": zmin, "zmax": zmax}};
            for (let step = 0; step <= tradeRoute.route.length; step++) {
                let planet = vgap.getPlanet(tradeRoute.route[step % tradeRoute.route.length]);
                markup.points.push({'x': planet.x + offset, 'y': planet.y + offset})
            }
            layer.markups.push(markup);
        }
        count++;
    }

    if (count == 0) {
        return;
    }

    // save to map
    if (overlays.length == 0) {
        overlays.push(layer);
    } else {
        let layerIndex = overlays.findIndex(entry => entry.name === layer.name);
        if (layerIndex !== -1) {
            console.log("Updating existing");
            overlays[layerIndex] = layer;
        } else {
            console.log("Adding new");
            overlays.push(layer);
            layerIndex = overlays.length - 1;
        }
    }
    vgap.map.drawingtool.current = {"overlay": layer, "markup": null, "editindex": null, "addType": "line"}
    vgap.map.draw();

    // save as note
    const note = vgap.getNote(0, -133919);
    // FIXME fails on no notes
    let body = [];
    if (note['body']) {
        body = JSON.parse(note['body']);
        layerIndex = body.findIndex(entry => entry.name === layer.name);
        if (layerIndex !== -1) {
            body[layerIndex] = layer;
        } else {
            body.push(layer);
        }
    } else {
        body.push(layer);
    }
    note['body'] = JSON.stringify(body);
    note["changed"] = 1;    
}

kesselrun.run = function () {
    const tradeRoutes = kesselrun.getTradeRoutes()
    tradeRoutes.forEach(route => kesselrun.handleRoute(route));
    kesselrun.updateShipNotes(true)
    vgap.map.draw();
};

kesselrun.processload = function() {
    kesselrun.checkDestroyed();
    kesselrun.updateShipNotes(false);
}

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

kesselrun.getTradeRoute = function(routeId) {
    const tradeRoutes = kesselrun.getTradeRoutes();
    return tradeRoutes.find(tr => tr.id === routeId);
}

kesselrun.saveTradeRoutes = function(tradeRoutes) {
    kesselrun.drawTradeRoutes(tradeRoutes);
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
    if (planet && (planet.id != origin)) {
        route.push(planet.id);
    } else if ((ship.hullid != 104) && (ship.hullid != 105)) {
        console.warn("No planet at the first ship destination");
        return;
    }

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
    if ((route.length == 1) && ((ship.hullid == 104) || (ship.hullid == 105))) {
        targets[origin]["supplies"] = 0;
    }

    // Create the initial assignments map for the ship
    const assignments = {};
    assignments[ship.id] = 0;

    // Return a new TradeRoute object
    return kesselrun.createTradeRoute(route, targets, assignments);
};

kesselrun.deleteTradeRoute = function(routeId) {
    // Retrieve the current trade routes
    const tradeRoutes = kesselrun.getTradeRoutes();

    // Remove ship notes
    const deletedRoute = kesselrun.getTradeRoute(routeId);
    Object.keys(deletedRoute.assignments).forEach(shipId => {
        const note = vgap.getShipNote(shipId);
        note.body = "";
        note.color = "";
        note.changed = 1;
    });

    // Filter out the trade route with the specified ID
    const updatedRoutes = tradeRoutes.filter(tr => tr.id !== routeId);

    // Save the updated trade routes back to the settings
    kesselrun.saveTradeRoutes(updatedRoutes);

    return updatedRoutes;
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

    const note = vgap.getShipNote(shipId);
    note.body = "TR" + routeId;
    note.color = kesselrun.sec_colors[routeId % kesselrun.sec_colors.length].substring(1);
    note.changed = 1;

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
    const note = vgap.getShipNote(shipId);
    note.body = "";
    note.color = "";
    note.changed = 1;

    // Save the updated trade routes back to the settings
    kesselrun.saveTradeRoutes(tradeRoutes);

    return true;
};

/** Move a planet up or down in the route */
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

/** Check routes for ships that no longer exist. */
kesselrun.checkDestroyed = function() {
    let tradeRoutes = kesselrun.getTradeRoutes();
    tradeRoutes.forEach(route => {
        Object.keys(route.assignments).forEach(shipId => {
            let ship = vgap.getShip(shipId);
            if (!ship || ship.ownerid != vgap.player.id) {
                console.log(`Removing ship ${shipId} from route ${route.id} as it no longer exists`);
                delete route.assignments[shipId];
            }
        });
    });
    kesselrun.saveTradeRoutes(tradeRoutes);
};

// dialog functions

kesselrun.dialog = {};  // the dialog attributes

kesselrun.dialog.key = "KR: Dialog";

kesselrun.dialog.allColumns = [
    "ID", "Name", "Pl", "Sh", "Dist",
    "Tgt$", "TgtS", "TgtC", "TgtN", "TgtD", "TgtT", "TgtM",
    "$", "S", "C", "N", "D", "T", "M", "*"
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

/**
 * Show the amount available over target, bounded by demand. This is used to show
 * the balance between what is waiting for pickup and due to arrive at destinations
 * in the Trade Routes dialogue.
 */
kesselrun.availableTargets = function(tradeRoute, resource) {
    let mf = kesselrun.buildManifest(tradeRoute);
    let demand = Object.values(mf.demand).reduce((total, planet) => total + (planet[resource] || 0), 0);
    let total = 0;
    for (const planetId in tradeRoute.targets) {
        const planet = vgap.getPlanet(planetId);
        if (planet && typeof tradeRoute.targets[planetId][resource] !== 'undefined') {
            let avail = planet[resource] - (tradeRoute.targets[planetId][resource] || 0);
            total += Math.min(demand, Math.max(0, avail));
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
                help: "Available for transport / In transit in ships"},
    "planets": {fun: kesselrun.detail,
                buttons: ["Ships", "Add Ship", "Add Planet", "\u23CE"],
                help: "Showing Target and Available/Ground/(Production)"},
    "addplanet": {fun: kesselrun.detail,
                buttons: [],
                help: "Select planet to add to trade route"},
    "targets": {fun: kesselrun.detail,
                buttons: ["\u23CE"],
                help: "Set the amount of the resource you want delivered to the planet"},
    "onestop": {fun: kesselrun.detail,
                buttons: ["\u23CE"],
                help: "Set the amount of each resource to be loaded into the orbiting ship"},

};


// dialog creation
kesselrun.showPlanetTargetsDialog = function (planet) {
    const tradeRoute = kesselrun.dialog.parent;
    const parent = [tradeRoute, planet]
    const targets = kesselrun.RESOURCES;
    const cols = kesselrun.dialog.tgtColumns
    const mode = tradeRoute.route.length > 1 ? "targets" : "onestop";
    kesselrun.createDialog(mode, [tradeRoute, planet], targets, cols, null,
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
    } else if (kesselrun.dialog.mode === "targets" || kesselrun.dialog.mode === "onestop") {
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
    var ships = vgap.myships.filter(ship => !(ship.x === ship.targetx && ship.y === ship.targety) || ship.hullid == 104 || ship.hullid == 105);

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

kesselrun.escapeHtml = function(input) {
    return input
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
};

kesselrun.dialog.name = function(object) {
    return kesselrun.escapeHtml(object.name);
};

kesselrun.dialog.planets = function(object) {
    return object.route.length;
};

kesselrun.dialog.ships = function(object) {
    return Object.keys(object.assignments).length;
};

kesselrun.dialog.dist = function(object) {
    warpFun = function(d) {
        // allow for warpwells
        d = Math.max(0, d - 2);
        let w = Math.ceil(Math.sqrt(d));
        return (w<=9) ? w : "!";
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

kesselrun.dialog.tgtClans = function(object) {
    return kesselrun.target(object, "clans");
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

kesselrun.dialog.clans = function(object) {
    return kesselrun.dialog.modeFun(object, "clans");
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
    "TgtC": { fun: kesselrun.dialog.tgtClans, tt: "Target Clans" },
    "TgtN": { fun: kesselrun.dialog.tgtNeutronium, tt: "Target Neutronium" },
    "TgtD": { fun: kesselrun.dialog.tgtDuranium, tt: "Target Duranium" },
    "TgtT": { fun: kesselrun.dialog.tgtTritanium, tt: "Target Tritanium" },
    "TgtM": { fun: kesselrun.dialog.tgtMolybdenum, tt: "Target Molybdenum" },
    "$": { fun: kesselrun.dialog.megacredits, tt: "Megacredits" },
    "S": { fun: kesselrun.dialog.supplies, tt: "Supplies" },
    "C": { fun: kesselrun.dialog.supplies, tt: "Clans" },
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
