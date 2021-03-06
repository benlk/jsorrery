/** 


*/

import { Vector3 } from 'three';

import { USE_PHYSICS_BY_DEFAULT, DEFAULT_CALCULATIONS_PER_TICK, KM, J2000 } from 'constants';
import Labels from 'graphics2d/Labels';
import Scene from 'graphics3d/Scene';
import ResourceLoader from 'loaders/ResourceLoader';
import Ticker from 'algorithm/Ticker';
import CelestialBody from 'CelestialBody';
import Gui, { START_ID, DELTA_T_ID } from 'gui/Gui';

export default {
	init(scenario, qstrSettings) {
		ResourceLoader.reset();
		this.name = scenario.name;
		this.scenario = scenario;
		const initialSettings = Object.assign({}, scenario.defaultGuiSettings, qstrSettings, scenario.forcedGuiSettings);
		// console.log(initialSettings);
		Gui.setDefaults(initialSettings);
		
		this.usePhysics = scenario.usePhysics || USE_PHYSICS_BY_DEFAULT;
		
		Labels.init(); 

		//start/stop
		Gui.addBtn('play', START_ID, () => {
			this.playing = !this.playing;
		}, 'p');

		this.dateDisplay = Gui.addDate(() => {
			this.playing = false;
			this.epochTime = 0;
			this.currentTime = this.startEpochTime = this.getEpochTime(this.dateDisplay.getDate());
			this.repositionBodies();
			this.scene.onDateReset();
		});

		this.ticker = () => this.tick();
		
		this.playing = false;
		this.epochTime = 0;
		this.drawRequested = false;

		this.date = this.dateDisplay.getDate() || new Date();
		this.currentTime = this.startEpochTime = this.getEpochTime(this.date);
		
		this.createBodies(scenario);
		this.scene = Object.create(Scene);
		this.calculateDimensions();
		this.scene.createStage(scenario);

		this.initBodies(scenario);
		Ticker.setSecondsPerTick(scenario.secondsPerTick.initial);
		Ticker.setCalculationsPerTick(scenario.calculationsPerTick || DEFAULT_CALCULATIONS_PER_TICK);
		const onSceneReady = ResourceLoader.getOnReady();

		onSceneReady.done(() => {
			this.showDate();
			Gui.putDefaults();
			this.scene.setCameraDefaults(initialSettings.cameraSettings);
			this.scene.draw();
			this.tick();
		});

		//delta T slider
		Gui.addSlider(DELTA_T_ID, scenario.secondsPerTick, (val) => {
			// console.log(val, scenario.secondsPerTick);
			Ticker.setSecondsPerTick(val);
		});

		return onSceneReady;

	},

	kill() {
		//kills the animation callback
		this.killed = true;
		this.dateDisplay.setDate(null);
		if (!this.scene) return;
		this.scene.kill();
		this.centralBody = null;
		this.scene = null;
		this.bodies = [];
		this.bodiesByName = {};

		Labels.kill();
	},

	createBodies(scenario) {
		
		const bodiesNames = Object.keys(scenario.bodies);
		this.bodies = bodiesNames.map(name => {
			const config = scenario.bodies[name];
			const body = Object.create(CelestialBody);
			Object.assign(body, config);
			body.name = name;
			return body;
		});

		this.centralBody = this.bodies.reduce((current, candidate) => {
			return current && current.mass > candidate.mass ? current : candidate;
		}, null);

		this.bodiesByName = this.bodies.reduce((byName, body) => {
			byName[body.name] = body;
			return byName;
		}, {});

		this.bodies.sort((a, b) => {
			return ((a.relativeTo || 0) && 1) - ((b.relativeTo || 0) && 1);
		});

		this.centralBody.isCentral = true;
		// console.log(this.bodies);
	},

	initBodies(scenario) {
		this.bodies.forEach(body => {
			if ((typeof scenario.calculateAll === 'undefined' || !scenario.calculateAll) && !body.isCentral) {
				body.mass = 1;
			}
			body.init();
			body.setPositionFromDate(this.currentTime);
		});

		this.setBarycenter();

		//after all is inialized
		this.bodies.forEach(body => {
			// console.log(body.name, body.isCentral);
			this.scene.addBody(body);
			body.afterInitialized(true);
		});
		
		this.scene.setCentralBody(this.centralBody);

		Ticker.setBodies(this.bodies);
	},
	/* balance the system by calculating hte masses of the non-central bodies and placing the central body to balance it.*/
	setBarycenter() {
		const central = this.centralBody;
		
		if (!this.usePhysics || central.isStill || this.scenario.useBarycenter === false) return;
		let massRatio;
		const massCenter = {
			mass: 0,
			pos: new Vector3(),
			momentum: new Vector3(),
		};

		this.bodies.forEach((b) => {
			if (b === central) return;
			massCenter.mass += b.mass;
			massRatio = b.mass / massCenter.mass;
			massCenter.pos = massCenter.pos.add(b.getPosition().multiplyScalar(massRatio));
			massCenter.momentum = massCenter.momentum.add(b.getAbsoluteVelocity().multiplyScalar(b.mass));
		});

		massCenter.momentum.multiplyScalar(1 / massCenter.mass);
		massRatio = massCenter.mass / central.mass;
		central.setVelocity(massCenter.momentum.multiplyScalar(massRatio * -1));
		central.position = massCenter.pos.clone().multiplyScalar(massRatio * -1);
		// console.log(central.position);
		this.bodies.forEach((b) => {
			if (b === central || (b.relativeTo && b.relativeTo !== central.name)) return;
			b.addToAbsoluteVelocity(central.getAbsoluteVelocity());
			//if central body's mass is way bigger than the object, we assume that the central body is the center of rotation. Otherwise, it's the barycenter
			if (central.mass / b.mass > 10e10) {
				b.position.add(central.position);
			} else if (b.relativeTo === central.name) {
				b.relativeTo = false;
			}
		});
	},

	repositionBodies() {
		// console.log(this.bodies);

		this.bodies.forEach(body => {
			body.reset();
			body.setPositionFromDate(this.currentTime);
			// console.log(body.name);
		});

		Ticker.tick(false, this.currentTime);

		this.setBarycenter();

		//adjust position depending on other bodies' position (for example a satellite is relative to its main body)
		this.bodies.forEach(body => {
			body.afterInitialized(false);
		});
	},

	getBody(name) {
		// console.log(this);
		if (name === 'central' || !name) {
			return this.centralBody;
		}
		return this.bodiesByName[name];
	},

	calculateDimensions() {
		const centralBodyName = this.getBody().name;
		//find the largest radius in km among all bodies
		let largestRadius = this.bodies.reduce((memo, body) => {
			return memo < body.radius ? body.radius : memo;
		}, 0);
		//find the largest semi major axis in km among all bodies
		let largestSMA = this.bodies.reduce((memo, body) => { 
			return (!body.isCentral && body.orbit && body.orbit.base.a > memo) ? body.orbit.base.a : memo;
		}, 0);
		let smallestSMA = this.bodies.reduce((memo, body) => { 
			return (!body.isCentral && body.orbit && (!body.relativeTo || body.relativeTo === centralBodyName) && (!memo || body.orbit.base.a < memo)) ? body.orbit.base.a : memo;
		}, 0);
		smallestSMA *= KM;
		largestSMA *= KM;
		largestRadius *= KM;

		//console.log('universe size', largestSMA, ' m');
		
		this.size = largestSMA;
		this.scene.setDimension(largestSMA, smallestSMA, largestRadius);

	},

	showDate() {
		this.date.setTime(J2000.getTime() + (this.currentTime * 1000));
		this.dateDisplay.setDate(this.date);
	},

	tick() {
		if (this.killed) return;
		if (this.playing) {
			this.epochTime += Ticker.getDeltaT();
			this.currentTime = this.startEpochTime + this.epochTime;
			Ticker.tick(this.usePhysics, this.currentTime);
			
			this.scene.updateCamera();
			this.scene.draw();
			this.showDate();
		} else {
			this.scene.updateCamera();
			if (this.drawRequested) this.scene.draw();
		}
		this.drawRequested = false;
		window.requestAnimationFrame(this.ticker);
	},

	requestDraw() {
		this.drawRequested = true;
	},

	getScene() {
		return this.scene;
	},

	getEpochTime(userDate) {
		const reqDate = userDate || new Date();
		return ((reqDate - J2000) / 1000);
	},

	isPlaying() {
		return this.playing;
	},

	stop(skipRender) {
		this.playing = false;
		if (skipRender) return;
		this.scene.updateCamera();
		this.scene.draw();
	},
};
