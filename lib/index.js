'use strict';

var debug = require('debug')('arena');

var settings = require('./settings');
var settingsGUI = require('./settings-gui');

var now = require('now');
var _ = require('lodash');
var tic = require('tic')();
var async = require('async');
var TWEEN = require('tween');
var Stats = require('../vendor/stats');
var detector = require('../vendor/detector');
var inherits = require('inherits');
var EventEmitter = require('EventEmitter');
var interact = process.browser ? require('interact') : null;
// var requestAnimationFrame = require('request-animation-frame').requestAnimationFrame;

var Machine = require('machinejs');


var HUD = require('./hud');
var Crowd = require('./crowd');
var Utils = require('./utils');
var Entity = require('./entity');
var LifeBar = require('./elements/slifebar');
var DestinationMarker = require('./controls/destinationmarker');
var Terrain = require('./elements/terrain');
var InteractiveObject = require('./elements/interactiveobject');
var PathFinding = require('./pathfinding');
var CameraControls = require('./controls/dota');
var SpellTexts = require('./hud/spelltexts');
var Collectible = require('./elements/collectible');
var MouseControls = require('./input/mouse');
var GamepadControls = require('./input/gamepad');
var ZoneSelector = require('./controls/zoneselector');

module.exports = Arena;

/**
 * The main game class
 * 
 * @exports Arena
 * 
 * @constructor
 * 
 * @param {object} settings
 * @param {string} settings.container Game container #id
 * @param {string} settings.splashContainer Game splashscreen, to be hidden when the game will start
 * 
 * @param {number=} settings.speed Game speed. Accelerated > 1 > Deccelerated
 * 
 * @param {object=} settings.fog Fog settings
 * @param {colorstring=} settings.fog.color Fog color
 * @param {number=} settings.fog.near Fog near
 * @param {number=} settings.fog.far Fog far
 * 
 * @param {object=} settings.hud HUD settings
 * @param {number=} settings.hud.mouseBorderDetection Border percentage after which the camera moves, set to false to disable
 *
 * @param {object=} settings.debug Debugging settings
 * @param {boolean=} settings.debug.showRoutes Show character routes as they are created
 * @param {boolean=} settings.debug.visibleCharactersHelpers Show characters bounding boxes
 * 
 */
var Arena = function (overrideSettings) {

  if (process.browser && this.notCapable()) {
    return;
  }

  // FIXME
  window._ta_events = new EventEmitter();

  var self = this;

  if (this.setMaxListeners) {
    this.setMaxListeners(1000);
  }

  /**
   * The game params
   * @type {Object}
   */
  this.settings = settings.data;

  for (var s in overrideSettings) {
    this.settings[s] = overrideSettings[s];
  }

  //////////

  /**
   * True if the game has started 
   * @type {Boolean}
   */
  this.started = false;

  /**
   * True if the game is currently running
   * @type {Boolean}
   */
  this.running = false;

  /**
   * The unique detination marker, repositioned on every moves
   * @type {DestinationMarker}
   */
  this.destinationMarker = new DestinationMarker(this);

  this._defaultZoneSelector = new ZoneSelector(this);

  this.selectionElement = $('#selection-rectangle');

  /**
   * The game clock
   * @type {THREE.Clock}
   */
  this.clock = new THREE.Clock();

  this.pathfinder = new PathFinding(this);

  /**
   * Each team objectives
   * @type {Object}
   */
  this.objectives = {
    0: null,  // team 2 objective
    1: null,  // team 1 objective
  };

  /**
   * The terrain
   * @type {Terrain}
   */
  this.ground = null;

  /**
   * The crowd system
   * @type {Crowd}
   */
  this.crowd = null;

  /**
   * Current selection callback, or null if no selection is waited
   * @type {Function}
   */
  this._waitForEntitySelection = null;

  /**
   * All entities
   * @type {Array}
   */
  this.entities = [];

  /**
   * Currently selected entity
   * @type {Array}
   */
  this.entity = null;

  /**
   * All intersectable objects
   * @type {Array}
   */
  this.intersectObjects = [];

  /**
   * The state machine enine
   * @type {Machine}
   */
  this.machine = new Machine();

  /**
   * Parent of all helpers
   * @type {THREE.Object3D}
   */
  this.helpers = new THREE.Object3D();

  /**
   * The game HUD
   * @type {HUD}
   */
  this.hud = new HUD.GameHud('hud-container');
  this.hud.attachGame(this);

  this.spelltexts = new SpellTexts(this);

  //////////

  this.commonMaterials = {

    'entityHelpers': new THREE.MeshBasicMaterial({
      wireframe: true,
      wireframeLinewidth: 2,
      color: 0xff0000,
      transparent: true,
      opacity: settings.data.visibleCharactersHelpers ? 0.8 : 0
    })

  };

  //////////

  settings.on('helpersUpdated', function(){

    _.each(self.entities, function(entity){
      entity[ settings.data.visibleCharactersHelpers ? 'add' : 'remove' ](entity.axisHelper);
      entity[ settings.data.visibleCharactersHelpers ? 'add' : 'remove' ](entity.bboxHelper);
      entity[ settings.data.visibleCharactersHelpers ? 'add' : 'remove' ](entity.radiusHelper);
      entity._visibleRadiusHelper.scale.set(entity.state.radius, entity.state.height, entity.state.radius);
    });

  });

  settings.on('cameraUpdated', function(){

    self.zoom(settings.data.cameraFov);
  });

  //////////

  if (this.settings.enableGLStats) {
    this.stats = new Stats();
    this.stats.domElement.style.position = 'absolute';
    this.stats.domElement.style.top = '0px';
    this.settings.container.appendChild( this.stats.domElement );
  }

  /**
   * The dat.GUI instance 
   * @type {dat.GUI}
   */
  this.gui = settingsGUI.create({ });

  //////////

  this._initScene(function () { });
  
  //////////

  this.on('set:terrain', function(){

    _.each(self.entities, function(obj){
      self.groundObject(obj);
    });

    // this.on('set:renderer', function(){
    //   // depends on terrain size
    //   self._clampCameraToGround();
    // });

  });
};

inherits(Arena, EventEmitter);


Arena.prototype.use = function(Component) {
  new Component(this);
};

/**
 * Test the WebGL environement
 * 
 * @return True if the current environement is not WebGL capable
 */
Arena.prototype.notCapable = function() {

  if (! detector().webgl) {
    this.settings.container.append(this.notCapableMessage());
    return true;
  }
  return false;
};

/**
 * A WebGL incentive message, for diasbled browsers
 * 
 * @return A DOM node element
 */
Arena.prototype.notCapableMessage = function() {
  var wrapper = document.createElement('div');
  wrapper.className = 'errorMessage';
  var a = document.createElement('a');
  a.title = 'You need WebGL and Pointer Lock (Chrome 23/Firefox 14) to play this game. Click here for more information.';
  a.innerHTML = a.title;
  a.href = 'http://get.webgl.org';
  wrapper.appendChild(a);
  return wrapper;
};

/**
 * Init the pathfinding subsystem, and load its settings.preload urls
 * 
 * @param  {Function} callback called when finished
 */
Arena.prototype.preload = function(done, progressCallback) {

  var self = this;

  if (this.settings.preload.length > 0) {

    var tasks;

    if (progressCallback) {

      var total = this.settings.preload.length;
      tasks = [];

      for (var i = 0; i < this.settings.preload.length; i++) {
        tasks.push(function(pdone){
          var selfFunc = this;
          self.settings.preload[selfFunc.preloadIndex](function(){
            progressCallback(selfFunc.step, selfFunc.total);
            pdone();
          });
        }.bind({ preloadIndex:i, step:i+1, total:total }));
      }

    } else {
      tasks = this.settings.preload;
    }

    async.parallel(tasks, function() {
      self.settings.preload.length = 0;
      done();
    });

  } else {

    if (progressCallback) {
      progressCallback(1, 1);
    }

    done();
  }
};

/**
 * Init the game, reset characters and map elements
 * 
 * @param  {Function} callback called when ready to run
 * 
 * @fires module:threearena/game#ready
 */
Arena.prototype.init = function(ready) {

  var self = this;

  async.series([

    function(done){
      async.parallel([

        function(pdone){ self._initCrowd(pdone); },   // crowd

        function(pdone){ self._initCamera(pdone); },  // camera

        function(pdone){ self._initLights(pdone); },  // lights

        function(pdone){ self._initRenderer(pdone); },// lights

      ], done);
    },

    function(done){ self._initSky(done); },   // sky needs terrain

    function(done){ self.emit('ready', self); done(); },

  ], function(){ ready(self); });
};

/**
 * Init the game camera
 * 
 * @private
 */
Arena.prototype._initCamera = function(done) {

  var dims = this.getContainerDimensions();

  this.camera = new THREE.PerspectiveCamera( 50, dims.width / dims.height, 1, 10000 );

  this.emit('set:camera');

  done();
};

/**
 * Init scene
 * 
 * @private
 */
Arena.prototype._initScene = function(done) {

  var self = this;

  this.scene = new THREE.Scene();
  this.scene.fog = new THREE.Fog( settings.data.fogColor, settings.data.fogNear, settings.data.fogFar );

  this.scene.add(this.destinationMarker);
  this.scene.add(this.helpers);

  this.scene2 = new THREE.Scene();
  this.scene2.fog = new THREE.Fog( settings.data.fogColor, settings.data.fogNear, settings.data.fogFar );

  this.emit('set:scene');

  settings.on('fogUpdated', function(){
    //this.scene.fog.color.set(settings.data.fogColor);
    self.scene.fog.near = settings.data.fogNear;
    self.scene.fog.far = settings.data.fogFar;

    //self.scene2.fog.color.set(settings.data.fogColor);
    self.scene2.fog.near = settings.data.fogNear;
    self.scene2.fog.far = settings.data.fogFar;
  });

  done();
};

/**
 * Init scene
 * 
 * @private
 */
Arena.prototype._initCrowd = function(done) {

  this.crowd = new Crowd(this);

  this.emit('set:crowd');

  done();
};


/**
 * Init global game lights
 * 
 * @private
 */
Arena.prototype._initLights = function(done) {

  var self = this;

  this.frontAmbientLight = new THREE.AmbientLight( 0xffffff );
  this.scene2.add( this.frontAmbientLight );

  this.ambientLight = new THREE.AmbientLight( settings.data.lightAmbientColor );
  this.scene.add( this.ambientLight );

  // SpotLight( hex, intensity, distance, angle, exponent )
  // PointLight( hex, intensity, distance )

  /*
  this.pointLight = new THREE.PointLight( 0xffffff, 1, 100 ); //, Math.PI );
  this.pointLight.shadowCameraVisible = true;
  this.pointLight.position.set( -20, 0, 20 );
  */

  this.pointLight = new THREE.SpotLight( settings.data.lightPointColor, 1, 100, Math.PI );
  this.pointLight.shadowCameraVisible = true;
  this.pointLight.shadowCameraNear = 10;
  this.pointLight.shadowCameraFar = 100;
  this.pointLight.position.set( 0, 180, 0 );
  this.pointLight.intensity = 5;
  this.pointLight.distance = 250;
  this.pointLight.angle = 0.5;
  this.pointLight.exponent = 40;
  this.pointLight.ambient = 0xffffff;
  this.pointLight.diffuse = 0xffffff;
  this.pointLight.specular = 0xffffff; // new THREE.Color('#050101'); // 0xaaaa22;
  this.scene.add(this.pointLight);



  this.directionalLight = new THREE.SpotLight( settings.data.lightDirectionalColor, 1, 800 );
  this.directionalLight.ambient = 0xffffff;
  this.directionalLight.diffuse = 0xffffff;
  this.directionalLight.specular = 0xffffff; // new THREE.Color('#050101'); // 0xaaaa22;

  this.directionalLight.position.set( -200, 400, -200 );
  this.directionalLight.intensity = 2;
  this.directionalLight.castShadow = settings.data.lightDirectionalShadows;
  this.directionalLight.shadowMapWidth = 1024;
  this.directionalLight.shadowMapHeight = 1024;
  this.directionalLight.shadowMapDarkness = 0.95;
  this.directionalLight.shadowCameraVisible = true;
  this.scene.add( this.directionalLight );

  this.emit('set:lights');

  settings.on('lightsUpdated', function(){

    self.ambientLight.color.set(settings.data.lightAmbientColor);

    self.pointLight.color.set(settings.data.lightPointColor);
    self.pointLight.intensity = settings.data.lightPointIntensity;
    self.pointLight.distance = settings.data.lightPointDistance;
    self.pointLight.angle = settings.data.lightPointAngle;
    
    self.directionalLight.color.set(settings.data.lightDirectionalColor);
    self.directionalLight.intensity = settings.data.lightDirectionalIntensity;
    self.directionalLight.distance = settings.data.lightDirectionalDistance;
    self.directionalLight.castShadow = settings.data.lightDirectionalShadows;

  });

  done();
};

/**
 * Init the renderer
 * 
 * @private
 */
Arena.prototype._initRenderer = function(done) {

  var dims = this.getContainerDimensions();

  this.renderer = new THREE.WebGLRenderer();
  this.renderer.shadowMapEnabled = true;
  this.renderer.shadowMapSoft = true;
  // this.renderer.shadowMapType = THREE.PCFSoftShadowMap;

  this.renderer.shadowCameraNear = 3;
  this.renderer.shadowCameraFar = this.camera.far;
  this.renderer.shadowCameraFov = 50;

  this.renderer.autoClear = false;
  this.renderer.gammaInput = true;
  this.renderer.gammaOutput = true;
  this.renderer.physicallyBasedShading = true;

  // this.renderer.shadowMapBias = 0.0039;
  // this.renderer.shadowMapDarkness = 0.5;
  // this.renderer.shadowMapWidth = dims.width;
  // this.renderer.shadowMapHeight = dims.height;

  this.renderer.setClearColor( this.scene.fog.color, 1 );

  this.renderer.setSize( dims.width, dims.height);

  this._effectsPass = {
    renderModel  : new THREE.RenderPass( this.scene, this.camera ),
    effectBleach : new THREE.ShaderPass( THREE.BleachBypassShader ),
    effectColor  : new THREE.ShaderPass( THREE.ColorCorrectionShader ),
    effectFXAA   : new THREE.ShaderPass( THREE.FXAAShader )
  };

  this._effectsPass.effectFXAA.uniforms.resolution.value.set( 1 / dims.width, 1 / dims.height );
  this._effectsPass.effectBleach.uniforms.opacity.value = 0.2;
  this._effectsPass.effectColor.uniforms.powRGB.value.set( 1.4, 1.45, 1.45 );
  this._effectsPass.effectColor.uniforms.mulRGB.value.set( 1.1, 1.1, 1.1 );
  this._effectsPass.effectFXAA.renderToScreen = true;

  this.composer = new THREE.EffectComposer( this.renderer );
  this.composer.addPass( this._effectsPass.renderModel );

  if (settings.data.quality >= settings.QUALITY_HIGH) {
    this.composer.addPass( this._effectsPass.effectColor );
  }

  if (settings.data.quality >= settings.QUALITY_BEST) {
    this.composer.addPass( this._effectsPass.effectBleach );
  }

  this.composer.addPass( this._effectsPass.effectFXAA );

  this.settings.container.appendChild( this.renderer.domElement );

  // CONTROLS

  //this.cameraControls = new THREE.TrackballControls( this.camera, this.renderer.domElement );
  this.cameraControls = new CameraControls( this.camera, this.renderer.domElement, this.settings.hud );
  this.cameraControls.domElement = this.renderer.domElement;

  this.emit('set:renderer');

  if (this.gui) {
    var folder = this.gui.addFolder('Renderer');
    _.each(this._effectsPass, function(effect, name){
      folder.add(effect, 'enabled').name(name);
    });
  }

  done();
};

/**
 * Clamp the camera movement to the ground boundings
 * 
 * @private
 */
Arena.prototype._clampCameraToGround = function() {

  if (this.cameraControls) {
    this.cameraControls.clamp = {
      xmin: this.ground.boundingBox.min.x * 0.9,
      xmax: this.ground.boundingBox.max.x * 0.9,
      zmin: this.ground.boundingBox.min.z * 0.9 + 30,
      zmax: this.ground.boundingBox.max.z * 0.9 + 50
    };
  }
};

/**
 * Init the skybox
 * 
 * @private
 * @param  {Function} done called when finished
 */
Arena.prototype._initSky = function(done) {
  var urlPrefix = '/gamedata/skybox/darkred_';
  var urls = [
    urlPrefix + 'posx.jpg', urlPrefix + 'negx.jpg',
    urlPrefix + 'posy.jpg', urlPrefix + 'negy.jpg',
    urlPrefix + 'posz.jpg', urlPrefix + 'negz.jpg'
  ];
  var textureCube = THREE.ImageUtils.loadTextureCube( urls );

  var shader = THREE.ShaderLib['cube'];
  var uniforms = THREE.UniformsUtils.clone( shader.uniforms );
  uniforms['tCube'].value = textureCube;
  var material = new THREE.ShaderMaterial({
    fragmentShader: shader.fragmentShader,
    vertexShader: shader.vertexShader,
    uniforms: uniforms,
    depthWrite: false
  });

  this.on('set:terrain', function(terrain){

    // build the skybox Mesh 
    var skyboxMesh = new THREE.Mesh( new THREE.CubeGeometry( 1000, 1000, 1000 ), material );
    skyboxMesh.flipSided = true;
    // tskyboxMesh.renderDepth = 1e20;
    this.scene.add( skyboxMesh );
  });

  done();
};


// # Debugging methods

Arena.prototype.addMarker = function(position) {
  var geometry = new THREE.SphereGeometry( 0.1, 10, 10 );
  var material = new THREE.MeshPhongMaterial( { color: 0xffffff, shading: THREE.FlatShading } );
  var mesh = new THREE.Mesh( geometry, material );
  mesh.position.copy(position);
  this.scene.add(mesh);
};

// # Misc internal methods

Arena.prototype.setInterval = tic.interval.bind(tic);
Arena.prototype.setTimeout = tic.timeout.bind(tic);

// teardown methods
Arena.prototype.destroy = function() {
  clearInterval(this.timer);
};

/**
 * Attach a listener for the next entity selection. There can be only one listener.
 * 
 * @param  {Function} onSelection
 */
Arena.prototype.waitForEntitySelection = function(onSelection) {

  if (typeof onSelection === 'function') {
    $(this.settings.container).addClass('waitForEntitySelection');
  } else {
    $(this.settings.container).removeClass('waitForEntitySelection');
    onSelection = null;
  }

  this._waitForEntitySelection = onSelection;
};

/**
 * Attach a listener for the next zone selection. There can be only one listener.
 * 
 * @param  {Function} onSelection
 */
Arena.prototype.waitForZoneSelection = function(onSelection, zoneSelector) {

  // create a bound if not already present
  this.__tmp_zoneSelectorListener = this.__tmp_zoneSelectorListener || this.updateZoneSelector.bind(this);

  if (typeof onSelection === 'function') {
    $(this.settings.container).addClass('waitForZoneSelection');
    this._currentZoneSelector = zoneSelector || this._defaultZoneSelector;
    this.scene.add(this._currentZoneSelector);
    this.on('cursor:move', this.__tmp_zoneSelectorListener);

  } else {

    this.off('cursor:move', this.__tmp_zoneSelectorListener);
    $(this.settings.container).removeClass('waitForZoneSelection');
    this.scene.remove(this._currentZoneSelector);
    onSelection = null;
  }

  this._waitForZoneSelection = onSelection;
};

/**
 * Cast a Raycaster in camera space
 * 
 * @param  {Array} objects specify which objects to raycast against, all intersectables object by default
 * @return {object} An intersections object
 *
 * @example
 * window.onClick = function ( event ) {
 *   var inter = game.raycast( event, candidates );
 *   console.log( "ray intersects %d objects, first one in sight is %o (face %o) at %o",
 *       inter.length, inter[0].object, inter[0].face, inter[0].point );
 * }
 */
Arena.prototype.raycast = function( event, objects ) {

  objects = objects || this.intersectObjects;

  if (! this._raycasterVector) {
    this._raycasterVector = new THREE.Vector3();
  }

  var dims = this.getContainerDimensions();

  this._raycasterVector.set(
     (event.layerX / dims.width) * 2 - 1,
    -(event.layerY / dims.height) * 2 + 1,
    this.camera.near
  );

  if (! this._projector) {
    this._projector = new THREE.Projector();
  }

  this._projector.unprojectVector(this._raycasterVector, this.camera);

  this._raycaster = new THREE.Raycaster(this.camera.position,
      this._raycasterVector.sub(this.camera.position).normalize());

  var intersects = this._raycaster.intersectObjects(objects, true); // recursive

  return intersects;
};

////////////////////////////////

/**
 * Get the game container dimensions
 * 
 * @return {object} { width:W, height:H }
 */
Arena.prototype.getContainerDimensions = function() {

  var $container = this.started ? $(this.settings.container) : $(window);

  return {
    width: $container.outerWidth(),
    height: $container.outerHeight()
  };
};

/**
 * Set listeners to play the game in the browser
 * 
 * @private
 */
Arena.prototype._initControls = function() {

  this.mouseControls = new MouseControls(this);
  this.gamepadControls = new GamepadControls(this);

  this.settings.container.addEventListener('mousemove', this._onCursorMove.bind(this), false );
  this.settings.container.addEventListener('keyup', this._onKeyUp.bind(this), false );

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', this._onWindowResize.bind(this), false);
  }
};

/**
 * Test a key against the specified binding
 * @param  {literal} value  Value to be tested
 * @param  {string} key Binding name: 
 * @return {boolean} True if the value match the specified binding name config 
 */
Arena.prototype._testKey = function(value, key) {

  var test = this.settings.keys[key];

  if (_.isArray(test)) {
    return this.settings.keys[key].indexOf(value);

  } else if (_.isFunction(test)) {
    return this.settings.keys[key](value);

  } else {
    return this.settings.keys[key] === value;
  }
};

/**
 * Resize listener
 * 
 * @private
 */
Arena.prototype._onWindowResize = function() {

  var dims = this.getContainerDimensions();

  var windowHalfX = dims.width / 2;
  var windowHalfY = dims.height / 2;
  this.camera.aspect = windowHalfX / windowHalfY;
  this.camera.updateProjectionMatrix();
  this.renderer.setSize( dims.width, dims.height );
  this._effectsPass.effectFXAA.uniforms.resolution.value.set( 1 / dims.width, 1 / dims.height );
};

/**
 * Keyboard listener
 * 
 * @private
 */
Arena.prototype._onKeyUp = function(event) {

  if (event.which === 27 && event.ctrlKey) {
    this.hud[ this.hud.isOpen() ? 'close' : 'open']();
  }

  if (event.which === 27 && !event.ctrlKey) {
    this[this.paused ? 'resume' : 'pause']();
  }

};

/**
 * Cursor move listener
 */
Arena.prototype._onCursorMove = function(event) {
  this.emit('cursor:move', event);
};

/**
 * Camera zoom
 * 
 * @private
 */
Arena.prototype.zoom = function(delta) {

  // settings.data.cameraHeight = Math.max(50, settings.data.cameraHeight - event.wheelDeltaY * 0.01);

  this.camera.fov += delta * 0.01;
  this.camera.fov = Math.min(this.camera.fov, 85);
  this.camera.fov = Math.max(this.camera.fov, 10);

  this.camera.updateProjectionMatrix();
};

/**
 * Update selction with screen coordinates
 * 
 * @private
 */
Arena.prototype.updateSelectionCoords = function(selX, selY) {

  if (this._inGroundSelection) {
    // in a selection
    var p1 = this._inGroundSelection.screen,
        p2 = { x: selX, y: selY },
        posleft = p1.x > p2.x ? p2.x : p1.x,
        postop = p1.y > p2.y ? p2.y : p1.y,
        selwidth = Math.abs(p1.x - p2.x),
        selheight = Math.abs(p1.y - p2.y);

    if (selheight > 2 && selwidth > 2) {
      this.selectionElement.css({
        height: selheight,
        width: selwidth,
        left: posleft,
        top: postop
      }).show();
    }
  }

};

/**
 * Update zone selection with screen coordinates
 * 
 * @private
 */
Arena.prototype.updateZoneSelector = function(event) {

  if (this._waitForZoneSelection) {
    var intersects = this.raycast(event, this.ground.children);
    if (intersects.length > 0) {
      this._currentZoneSelector.position.copy(intersects[0].point);
      this.groundObject(this._currentZoneSelector);
      this._currentZoneSelector.position.y += 0.1;
      this._currentZoneSelector.children[0].material.opacity = 0.9;
      this._currentZoneSelector.children[0].visible = true;
    }

    this._currentZoneSelector.emit('update');
    return;
  }
  this._currentZoneSelector.children[0].visible = false;
  this._currentZoneSelector.children[0].material.opacity = 0.001;
};

/////////////////////////////////////////
// TERRAIN

/**
 * Set the walkable terrain
 * 
 * @param {string} file Path to the .OBJ file
 * @param {object=} options Common three.js material options, plus options below (see RecastNavigation options)
 * @param {float=} options.cellSize Navmesh cell size (.8 > 2)
 * @param {float=} options.cellHeight Navmesh cell height (.5 > 1)
 * @param {float=} options.agentHeight Characters height (1.2 => 2)
 * @param {float=} options.agentRadius Characters radius (.5 > 2)
 * @param {float=} options.agentMaxClimb Max units characters can jump (1 > 5)
 * @param {float=} options.agentMaxSlope Max degre characters can climb (20 > 40)
 */
Arena.prototype.setTerrain = function(file, options) {

  var self = this;

  options = _.merge({

    cellSize: 2,            // nav mesh cell size (.8 > 2)
    cellHeight: 1.5,        // nav mesh cell height (.5 > 1)
    agentHeight: 2.0,       // character height (1.2 => 2)
    agentRadius: 0.2,       // character radius (.5 > 2)
    agentMaxClimb: 4.0,     // max units character can jump (1 > 5)
    agentMaxSlope: 30.0,    // max degre character can climb (20 > 40)

    wireframe: false,

    onLoad: null

  }, options, {
    onLoad: function(terrain) {
      self.ground = terrain;
      self.intersectObjects = self.intersectObjects.concat(self.ground.children[0].children);
      self.scene.add(self.ground);

      // ground bounding box
      self.ground.boundingBox = new THREE.Box3().setFromObject(self.ground);

      // normalized
      self.ground.boundingBoxNormalized = new THREE.Box3().copy(self.ground.boundingBox);
      self.ground.boundingBoxNormalized.translate(new THREE.Vector3(
        - self.ground.boundingBox.min.x,
        - self.ground.boundingBox.min.y,
        - self.ground.boundingBox.min.z
      ));

      /*
      self.ground.traverse(function (child) {
        if (child instanceof THREE.Mesh) {
          child.receiveShadow = true;

          // use provided boundinf box if present
          if (options.boundingBox) {
            child.geometry.boundingBox = options.boundingBox;
          // or compute it
          } else if (! child.geometry.boundingBox) {
            child.geometry.computeBoundingBox();
            // child.geometry.boundingBox = new THREE.Box3().setFromObject(child);
          }
          // fast access to ground bbox
          self.ground.boundingBox = child.geometry.boundingBox;

          // normalized
          self.ground.boundingBoxNormalized = new Box3().copy(child.geometry.boundingBox);
          self.ground.boundingBoxNormalized.translate(
            new THREE.Vector3( - box.min.x, - box.min.y, - box.min.z )
          );
        }
      });
      */

      // configure, and load the navigation mesh
      self.pathfinder.config({

        cellSize: options.cellSize,
        cellHeight: options.cellHeight,
        agentHeight: options.agentHeight,
        agentRadius: options.agentRadius,
        agentMaxClimb: options.agentMaxClimb,
        agentMaxSlope: options.agentMaxSlope

      }, function(){
        self.pathfinder.initWithFile(file, function() {

          debug('terrain ready');
          self.emit('set:terrain', self.ground);
        });
      });
    }
  });

  new Terrain(file, options);

  return this;
};

/**
 * Get the navigation mesh as a three.js mesh object
 *
 * Warning: you don't need this to have a walkable terrain.
 * This method is available for debugging purposes.
 * 
 * @param {function} callback Callback to be called with the produced THREE.Mesh
 */
Arena.prototype.computeNavigationMesh = function(callback) {

  var self = this;

  if (! self.navigationMesh) {
    // get the navmesh vertices
    self.pathfinder.getNavMeshVertices(
      Utils.gcb(function(vertices) {
        // build the mesh
        self.navigationMesh = Utils.meshFromVertices(vertices, {
          color: 0xffffff,
          wireframe: true,
          transparent: true,
          opacity: 0.8
        });
        self.scene.add(self.navigationMesh);
        if (callback) { callback(null, self.navigationMesh); }
      })
    );
  } else {
    if (callback) { callback(null, self.navigationMesh); }
  }
};

/**
 * Force an object to be grounded on the terrain surface
 *
 * @param {object} object THREE.Mesh, or any object with a position attribute.
 */
Arena.prototype.groundObject = function(object) {

  var self = this;

  if (self.ground) {
    // double-check the elevation, objects cannot be under ground
    var inifiniteElevation = new THREE.Vector3( object.position.x, 10000000, object.position.z );
    var raycaster = new THREE.Raycaster(inifiniteElevation, new THREE.Vector3(0, -1, 0));
    var intersects = raycaster.intersectObject(self.ground, true);

    if (intersects.length) {
      debug('grounded %o to y=%o', object, intersects[intersects.length - 1].point.y);
      object.position.y = intersects[intersects.length - 1].point.y;
    } else {
      throw 'object cannot be placed here';
    }
  } else {
    throw 'ground has not been set yet';
  }
};

/**
 * Get a random postion on the terrain surface.
 * 
 * @param  {Function} callback Callback to be called with the generated position
 */
Arena.prototype.randomPositionOnterrain = function(callback) {

  this.pathfinder.getRandomPoint(callback);
};

/**
 * Add an obstacle on the terrain surface, that will block future characters moves.
 * @param {object} position The obstacle position
 * @param {float} radius    Radius of the obstacle
 * @param {integer} flag    Walkable flags (0 will completely block moves)
 */
Arena.prototype.addObstacle = function(position, radius, flag) {
  
  radius = { x:radius, y:radius, z:radius };
  flag = flag || 0;

  if (this.settings.showObstacles) {
    var obsctacle = new THREE.Mesh(
      new THREE.PlaneGeometry(radius.x, radius.y, radius.z, 1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xff0000 })
    );
    obsctacle.position.copy(position);
    obsctacle.position.y += 0.2;
    //obsctacle.rotation.x = 90 * Math.PI / 180;
    this.scene.add(obsctacle);
  }

  this.pathfinder.setPolyUnwalkable(position, radius, flag);
};


/**
 * Setup an entity before it get added in the scene
 * 
 * @param  {Entity} entity The entity to be setup
 */
Arena.prototype._prepareEntity = function(entity) {

  var self = this;

  // give entities a reference to this
  entity.game = this;

  // entities in the crowd
  if (entity.character) {
    this.crowd.addAgent(entity, entity.state);

    self.entities.push(entity);
  }

  settingsGUI.addEntityControls(entity);

  entity.on('death', function(){
    settingsGUI.removeEntityControls(entity);
  });

  // entities should have a lifebar
  entity.attachLifeBar();

  // casts shadows
  entity.traverse(function (child) {
    if (child instanceof THREE.Mesh && child.parent && ! child.parent instanceof LifeBar) {
      child.castShadow = true;
    }
  });

  // setup its behaviour
  if (entity.behaviour) {
    entity.behaviour = self.machine.generateTree(entity.behaviour, entity, entity.states);
    // update event
    self.on('update:behaviours', function() {
      // debug('tick update behaviours');
      entity.behaviour = entity.behaviour.tick();
    });
  }

  // has a collision box
  var box = entity.boundingBox = new THREE.Box3();
  box.setFromObject(entity);

  // normalize it
  box.translate(new THREE.Vector3( - box.min.x, - box.min.y, - box.min.z ));

  entity.bboxHelper = new THREE.Mesh(new THREE.CubeGeometry(
    box.max.x + (/* box.max.x + */ 0.20), // a bit wider
    box.max.y + (/* box.max.y + */ 0.20), // a bit higher
    box.max.z + (/* box.max.z + */ 0.20), // a bit deeper
    1, 1, 1
  ), self.commonMaterials.entityHelpers);
  for (var i = 0; i < entity.bboxHelper.geometry.vertices.length; i++) {
    entity.bboxHelper.geometry.vertices[i].y += entity.bboxHelper.geometry.vertices[i].y / 2;
  }
  if (self.settings.visibleCharactersHelpers) {
    entity.add(entity.bboxHelper);
  }

  // has an axis helper
  entity.axisHelper = new THREE.AxisHelper(50);
  if (self.settings.visibleCharactersHelpers) {
    entity.add(entity.axisHelper); // axis
  }

  // has a radius helper
  entity.radiusHelper = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 16, 16, true), self.commonMaterials.entityHelpers);
  entity.radiusHelper.scale.set(entity.state.radius, entity.state.height, entity.state.radius);
  if (self.settings.visibleCharactersHelpers) {
    entity.add(entity.radiusHelper); // radius
  }



  // is intersectable
  self.intersectObjects.push(entity.bboxHelper);

  // add its lifebar in the alternative scene ..
  self.scene2.add(entity.lifebar);

  var update = function(game){
    // entity.lifebar.update(game.delta);

    // .. always above its character
    entity.lifebar.position.copy(entity.position);
    entity.lifebar.position.y += box.max.y;

    // .. always face camera
    entity.lifebar.rotation.y = self.camera.rotation.y;
  };
  update.listenerTag = 'entity ' + entity.constructor.name + '#' + entity.id + ' lifebar update';
  self.on('update', update);

  // whenever the character dies
  entity.on('death', function(){

    // remove the bbox from intersectables
    self.intersectObjects.splice(self.intersectObjects.indexOf(entity.bboxHelper), 1);

    // remove the lifebar
    if (entity.lifebar.parent) {
      entity.lifebar.parent.remove(entity.lifebar);
    }
  });

  self.emit('added:entity', entity);
};

/**
 * Add a static object
 * 
 * @param {Function(object)} builder Function to be called with the fully initialized object.
 * 
 * @fires module:threearena/game#added:static
 * 
 * @return {this} The game object
 * 
 * @example
 * game.addStatic(function (done) {
 *   var petShop = new Shop({
 *     onload: function () { done(this); }
 *   });
 * })
 */
Arena.prototype.addStatic = function(builder) {

  var self = this;

  var add = function(object) {

    // give object a reference to myself
    object.arena = this;

    if (self.ground) {
      self.groundObject(object);
    }

    if (object instanceof Entity) {
      self._prepareEntity(object);
    }

    if (object.isBlocking) {
      self.addObstacle(object.position, object.isBlocking);
    }

    if (object instanceof Collectible) {
      self.intersectObjects.push(object);
    }

    // On scene !
    self.scene.add(object);

    self.emit('added:static', object);
  };

  // argument is already an object, add it now
  if (! _.isFunction(builder)) {
    add(builder);

  // argument is a builder function, but game has already been started, build it now
  } else if (self.started) {
    builder(add, self);

  // argument is a builder function, and game has not been started, build it later
  } else {
    self.settings.preload.push(function(done){
      builder(function(object){
        add(object);
        done();
      }, self);
    });
  }

  return this;
};


/////////////////////////////////////////
// INTERACTIVES

/**
 * Add an interactive object
 * 
 * @param {InteractiveObject} builder Interactive Object
 * @param {object} options Options
 * 
 * @fires module:threearena/game#added:interactive
 * 
 * @return {this} The game object
 */
Arena.prototype.addInteractive = function(builder) {

  var self = this;

  var add = function(object) {
    self.intersectObjects.push(object);

    if (self.ground) {
      self.groundObject(object);
    }

    // On scene !
    self.scene.add(object);
  };

  // argument is already an object, add it now
  if (! _.isFunction(builder)) {
    add(builder);

  // argument is a builder function, but game has already been started, build it now
  } else if (self.started) {
    builder(add, self);

  // argument is a builder function, and game has not been started, build it later
  } else {
    self.settings.preload.push(function(done){
      builder(function(object){
        add(object);
        done();
      }, self);
    });
  }

  return this;
};

/**
 * End all not-near-enough interaction
 * 
 * @return {this} The game object
 */
Arena.prototype.endAllInteractions = function () {

  var character = this.entity;
  
  _.each(this._selected_objects, function (object) {
    if (object.isNearEnough && ! object.isNearEnough(character)) {
      object.deselect();
    }
  });

  return this;
};

/**
 * Begin a new interaction with an interactive object
 *
 * @param  {InteractiveObject} interactiveObject
 * 
 * @return {this} The game object
 */
Arena.prototype.startInteraction = function (interactiveObject) {

  this.endAllInteractions();
  this._selected_objects.push(interactiveObject);
  interactiveObject.select();
  this.hud.startInteraction(interactiveObject);

  return this;
};


/////////////////////////////////////////
// CHARACTERS

/**
 * Add a character. The first one is the main one
 * 
 * @param {Function(object)} builder Function to be called with the fully initialized object.
 *
 * @return {this} The game object
 * 
 * @example
 * game.addCharacter(function (done) {
 *   var character = new Ogro({
 *     onload: function () { done(this); }
 *   });
 * })
 * 
 * @fires module:threearena/game#added:entity
 */
Arena.prototype.addCharacter = function(builder) {

  var self = this;

  var add = function(object) {

    // characters are always grounded
    if (self.ground) {
      self.groundObject(object);
    }

    // Attach a life/mana bar above the entity
    self._prepareEntity(object);

    // On scene !
    self.scene.add(object);

    debug('add character %o', object);

    self.emit('added:character', object);
  };

  // argument is already an object, add it now
  if (! _.isFunction(builder)) {
    add(builder);

  // argument is a builder function, but game has already been started, build it now
  } else if (self.started) {
    builder(add, self);

  // argument is a builder function, and game has not been started, build it later
  } else {
    self.settings.preload.push(function(done){
      builder(function(object){
        add(object);
        done();
      }, self);
    });
  }

  return this;
};

/**
 * Remove a character from the scene
 * 
 * @param  {Entity} character
 * 
 * @return {this} The game object
 * 
 * @fires module:threearena/game#removed:entity
 */
Arena.prototype.removeCharacter = function(character) {

  this.entities = _.without(this.entities, character);
  this.scene.remove(character);

  return this;
};

Arena.prototype.asPlayer = function(entity) {

  this.entity = entity;
  this.hud.attachEntity(entity);
  this.camera.position.set( entity.position.x + 30, 50, entity.position.z + 40 );
};

/**
 * Current selected objects
 *
 * @private
 * @type {Array}
 */
Arena.prototype._selected_objects = [ ];

/**
 * Deselect all selected characters
 * 
 * @param  {Array} butCharacters These characters should not be deselected
 * 
 * @return {this} The game object
 *
 * @fires module:threearena/game#unselect:all
 */
Arena.prototype.unselectCharacters = function () {

  var self = this;
  var unselected = [];

  for (var i = 0; i < this._selected_objects.length; i++) {
    if (this._selected_objects[i]._marker) {
      this._selected_objects[i].remove(this._selected_objects[i]._marker);
    }
  }
  
  this._selected_objects.length = 0;
  self.waitForEntitySelection(null);
  this._inGroundSelection = null;
  $('#selection-rectangle').hide();

  self.emit('unselect:all', unselected);

  return this;
};

/**
 * Select all characters in a zone and return them. This method ignores Y component.
 * 
 * @param  {Vector3} start Top left point of the select area
 * @param  {Vector3} end Bottom right point of the select area
 * 
 * @return {Array} Array of selected characters
 * 
 * @fires module:threearena/game#select:entities
 */
Arena.prototype.selectCharactersInZone = function (start, end) {

  var self = this;

  var selected = _.filter(this.entities, function(character) {
    var itsin = ! character.isDead() &&
        character.position.x > start.x && character.position.z > start.z &&
        character.position.x < end.x && character.position.z < end.z;

    if (itsin) {
      self._selected_objects.push(character);
      var marker = new SelectMarker({
        onLoad: function(){
          character._marker = marker;
          character.add(marker);
        }
      });
    }

    return itsin;
  });

  debug('Need to find characters in %o > %o : %o', start, end, selected);

  self.emit('select:entities', selected);

  return selected;
};


/////////////////////////////////////////
// GAME FLOW

Arena.prototype.pause = function(){
  debug('pause');
  this.paused = true;
};

Arena.prototype.resume = function(){
  debug('resume');
  this.paused = false;
};

Arena.prototype.run = function() {
  debug('run');

  if (this.running) {
    throw new Error('already running');
  } else if (! this.started) {
    this.start();
  }

  var EXCEEDING_MAX_FRAME_TIME = 'exceeding max frameTime (%o): %o';
  var SLOW_UPDATE = 'slow update: %o ms';
  var SLOW_RENDER = 'slow render: %o ms';
  var SLOW_FRAME  = 'slow frame:  %o ms';

  var currentTime = now();
  var world = this.world;
  var accumulator = 0.0;
  var self = this;

  var timestep;
  var frameStart;

  var alpha;
  var newTime;
  var frameTime;
  var maxframeTime;

  self._timings = {};

  function changevisibility() {
    if (document.hidden === false || document.webkitHidden === false) {
      currentTime = now();
      self.delta = self.clock.getDelta() * self.settings.speed;
    }
  }
  document.addEventListener('visibilitychange', changevisibility, false);
  document.addEventListener('webkitvisibilitychange', changevisibility, false);

  function loop() {

    if (self.running) {
      requestAnimationFrame(loop);
    }

    timestep = settings.data.timestep;
    frameStart = now();
    self.emit('enter frame', world);

    if (! self.paused) {

      newTime = now();
      frameTime = newTime - currentTime;
      maxframeTime = timestep * settings.data.maxUpdatesPerFrame;
      currentTime = newTime;

      // note: max frame time to avoid spiral of death
      if (frameTime > maxframeTime){
        debug(EXCEEDING_MAX_FRAME_TIME, maxframeTime, frameTime);
        frameTime = maxframeTime;
      }

      // keep the delta
      // self.delta = timestep;

      // update
      var updatesStart = now();
      accumulator += frameTime;
      while (accumulator >= timestep) {
        self.emit('pre update', timestep);
        self.timestep = timestep / 1000;
        self.update();
        self.emit('post update', timestep);
        accumulator -= timestep;
        if (! self.running) {
          break;
        }
      }

      // interpolate between the previous and current physics state
      // based on how much time is left in the accumulator
      alpha = accumulator / timestep;
      self.timestep = alpha / 1000;
      if (self.timestep > 0.001) {
        self.update();
      }

      var updatesEnd = now();
      if (updatesEnd - updatesStart > timestep) {
        debug(SLOW_UPDATE, (updatesEnd - updatesStart).toFixed(2));
      }

      // render
      var renderStart = now();
      self.render();
      var renderEnd = now();
      if (renderEnd - renderStart > timestep) {
        debug(SLOW_RENDER, (renderEnd - renderStart).toFixed(2));
      }
    }

    self.emit('leave frame', world);

    var frameEnd = now();
    if (frameEnd - frameStart > timestep) {
      debug(SLOW_FRAME, (frameEnd-frameStart).toFixed(2));
    }
  }
  this.running = true;
  loop();
  return this;
};


/**
 * Start a new game
 *
 * @return {this} The game object
 * 
 * @fires module:threearena/game#start
 */
Arena.prototype.start = function() {

  var self = this;

  self.preload(function(){

    self._initControls();

    self.hud.open();

    self.emit('start');

    if (self.settings.splashContainer) {
      self.settings.splashContainer.className += ' animated fadeOutUpBig';
    }
    self.settings.container.style.className += ' animated fadeInUpBig';
    self.settings.container.style.display = 'block';

    self.started = true;

    // timers
    self._behaviours_delta = self.clock.getDelta();

  }, function(){
    debug('preload now... consider using preload() before the game starts');
  });

  return this;
};

/**
 * Where things are updated, inside the loop
 * 
 * @fires module:threearena/game#update
 * @fires module:threearena/game#update:behaviours
 */
Arena.prototype.update = function() {

  var self = this, start = null, end = null;

  this.delta = this.timestep;

  self._timings.lastDuration_taevents = window._ta_events.emit('update', this);

  // update event
  self._timings.lastDuration_updateevent = this.emit('update', this);

  // tick
  start = now();
  tic.tick(this.delta);
  end = now();
  self._timings.lastDuration_tick = end - start;

  // camera controls
  start = now();
  this.cameraControls.update(this.delta);
  end = now();
  self._timings.lastDuration_cameracontrols = end - start;

  // entities behaviours
  self._timings.lastDuration_behaviours = this.emit('update:behaviours', this);

  // current entity 
  start = now();

  if (this.entity) {

    // place a light near the main player
    this.pointLight.position.set(
      this.entity.position.x - 50,
      180,
      this.entity.position.z + 100
    );
    this.pointLight.target = this.entity;

    // camera position
    var cameraType = parseInt(settings.data.cameraType, 0);
    //this.camera.lookAt(this.entity.position);

    if (cameraType === settings.CAMERA_MANUAL) {
    
    } else if (cameraType === settings.CAMERA_FOLLOW) {
      this.camera.position.x = this.entity.position.x;
      this.camera.position.z = this.entity.position.z + 200;
    }

    // camera height ~ crraaaapp
    this.camera.position.y = this.entity.position.y + settings.data.cameraHeight;
  }

  end = now();
  self._timings.lastDuration_thisentity = end - start;

  // current entity 
  start = now();

  for (var i = 0; i < this.entities.length; i++) {
    if (this.entities[i].update) {
      this.entities[i].update(self);
    }
  }

  end = now();
  self._timings.lastDuration_entities = end - start;


  // current entity 
  start = now();
  // FIXME: Use this.speed
  TWEEN.update();
  end = now();
  self._timings.lastDuration_tween = end - start;


  // debug('timings %o', {
  //   taevents: self._timings.lastDuration_taevents,
  //   updateevent: self._timings.lastDuration_updateevent,
  //   tick: self._timings.lastDuration_tick,
  //   cameracontrols: self._timings.lastDuration_cameracontrols,
  //   behaviours: self._timings.lastDuration_behaviours,
  //   thisentity: self._timings.lastDuration_thisentity,
  //   entities: self._timings.lastDuration_entities,
  //   tween: self._timings.lastDuration_tween,
  //   total: self._timings.lastDuration_taevents +
  //     self._timings.lastDuration_updateevent +
  //     self._timings.lastDuration_tick +
  //     self._timings.lastDuration_cameracontrols +
  //     self._timings.lastDuration_behaviours +
  //     self._timings.lastDuration_thisentity +
  //     self._timings.lastDuration_entities +
  //     self._timings.lastDuration_tween + 'ms'
  // });
  
};

/**
 * Where things are rendered, inside the render loop
 * 
 * @fires module:threearena/game#update
 * @fires module:threearena/game#update:behaviours
 */
Arena.prototype.render = function() {

  // render scene
  this.renderer.clear();
  this.composer.render();

  // clear depth buffer & render front scene
  this.renderer.clear( false, true, false );
  this.renderer.render( this.scene2, this.camera );

  if (this.stats) {
    this.stats.update();
  }
};


/////////////////////////////////////////
// UNITY - LIKE

/**
 * Finds a game object by name and returns it.
 * 
 * @param name Name of object
 */
Arena.prototype.find = function(name) {
  return this.scene.getObjectByName(name);
};

/**
 * Finds all game objects tagged tag.
 *
 * @param tag tag name
 */
Arena.prototype.findAllWithTag = function(tag) {
  var found = [];

  this.scene.traverse(function (child) {
    if (child.tags && child.tags.indexOf(tag) > -1) {
      found.push(child);
    }
  });

  return found;
};

/**
 * Finds all game objects tagged tag and returns the nearest one from given position.
 *
 * @param tag tag name
 */
Arena.prototype.findWithTag = function(tag, from, filter) {
  var found = this.findAllWithTag(tag),
      distance = Number.MAX_VALUE,
      nearest = null;
  for (var i = 0; i < found.length; i++) {
    if (!from) {
      return found[i];
    }
    var d = found[i].position.distanceTo(from);
    if (d < distance && (!filter || filter(found[i]))) {
      nearest = found[i];
      distance = d;
    }
  }
  return nearest;
};

/**
 * Finds all game objects of class oneclass.
 *
 * @param tag tag name
 */
Arena.prototype.findAllWithClass = function(oneclass) {
  var found = [];

  this.scene.traverse(function (child) {
    if (child.constructor.name === oneclass) {
      found.push(child);
    }
  });

  return found;
};

/**
 * Finds all game objects of class oneclass and returns the nearest one from given position.
 *
 * @param tag tag name
 */
Arena.prototype.findWithClass = function(oneclass, from, filter) {
  var found = this.findAllWithClass(oneclass),
      distance = Number.MAX_VALUE,
      nearest = null;
  for (var i = 0; i < found.length; i++) {
    if (!from) {
      return found[i];
    }
    var d = found[i].position.distanceTo(from);
    if (d < distance && (!filter || filter(found[i]))) {
      nearest = found[i];
      distance = d;
    }
  }
  return nearest;
};

/////////////////////////////////////////

/**
 * Fired when the game is ready to be started
 *
 * @event module:threearena/game#ready
 * @type {object}
 */

/**
 * Fired when the game start
 *
 * @event module:threearena/game#start
 * @type {object}
 */

/**
 * Fired on every frame
 *
 * @event module:threearena/game#update
 * @type {Game}
 * @property {float} delta Delta time
 */

/**
 * Fired every some frames
 *
 * @event module:threearena/game#update:behaviours
 * @type {Game}
 * @property {float} delta Delta time
 */

/**
 * Fired when an entity has been added
 *
 * @event module:threearena/game#added:entity
 * @type {Entity}
 */

/**
 * Fired when a static object has been added
 *
 * @event module:threearena/game#added:static
 * @type {Object}
 */

/**
 * Fired when a spawning pool has been added
 *
 * @event module:threearena/game#added:spawningpool
 * @type {SpawningPool}
 */


if (window) { window.Arena = Arena; }

Arena.Behaviours = require('./behaviours/all');
Arena.Characters = require('./character/all');
Arena.Elements = require('./elements/all');
Arena.Spells = require('./spell/all');

Arena.stemkoski = require('./particles/stemkoski_ParticleEngine');


