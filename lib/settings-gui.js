'use strict';

/* global dat: true, _gaq: true */

/**
 * @exports SettingsGUI
 * 
 */

var settings = require('./settings');

var gui, crowd;

/**
 * Create a GUI
 *  
 * @return {dat.GUI}  The dat.GUI object
 */
module.exports.create = function( initParams ) {

  if (! settings.enableGUI) { return false; }

  // dat.GUI is global, included in the HTML
  gui = new dat.GUI({ autoPlace: false });
  settings.gui = gui;

  gui.width = 400;
  document.getElementsByTagName('body')[0].appendChild(gui.domElement);

  gui.domElement.addEventListener('click', logSettingsClick);

  function logSettingsClick(){
    gui.domElement.removeEventListener('click', logSettingsClick);
    _gaq.push(['_trackEvent', 'settings', 'open']);
  }

  var f;


  // GENERAL
  f = gui.addFolder('Generic');
  f.add(exports,'shortcut','O').name('Show panels');
  f.add(exports,'shortcut','0').name('Debug renderer');
  f.add(exports,'shortcut','H').name('Heal');
  f.add(settings.data, 'godMode').name('God mode');
  f.add(settings.data, 'quality',{
    'Best quality (antialiasing)': 3,
    'High quality': 2,
    'High performance': 1
  });
  f.add(settings.data, 'framerate').min(1).max(120).name('Framerate (fps)').onChange(framerateUpdated);
  f.add(settings.data, 'visibleCharactersHelpers').name('Entities helpers').onChange(helpersUpdated);
  f.add(settings.data, 'visibleCharactersRoutes').name('Entities routes');

  // CONTROLS
  f = gui.addFolder('Controls');
  f.add(settings.data.controls, 'mouseEnabled').name('Mouse enabled').listen();
  f.add(settings.data.controls, 'gamepadEnabled').name('Gamepad enabled').listen();

  // CAMERA
  f = gui.addFolder('Camera');
  f.add(settings.data, 'cameraType',{
    'Manual': 1,
    'Follow': 2,
  }).name('Type');
  f.add(settings.data, 'cameraHeight').min(10).max(1000).name('Height');
  f.add(settings.data, 'cameraFov').min(-1000).max(1000).name('FOV').listen().onChange(cameraUpdated);

  // FOG
  f = gui.addFolder('Fog');
  f.addColor(settings.data, 'fogColor').name('Color').listen().onChange(fogUpdated);
  f.add(settings.data, 'fogNear', 1, 200).name('Near').listen().onChange(fogUpdated);
  f.add(settings.data, 'fogFar', 1, 2000).name('Far').listen().onChange(fogUpdated);

  /*
  f = gui.addFolder('Camera');
  f.add(settings.data, 'cameraType',CAMERA_TYPES).name('Mode').listen().onChange(function(value){
    settings.data.cameraType = parseInt(value,10);
    settings.emit('cameraTypeChanged');
  }.bind(this));
  f.add(settings.data,'cameraOverlay').name('Overlay').onChange(function(){
    settings.emit('cameraSettingsChanged');
  }.bind(this));
  f.add(settings.data,'cameraFov').min(10).max(100).step(1).name('FOV').onChange(function(){
    settings.emit('cameraSettingsChanged');
  }.bind(this));
  f.add(settings.data,'cameraGrid').min(0).max(1).name('Scanlines').onChange(function(){
    settings.emit('cameraSettingsChanged');
  }.bind(this));
  f.add(exports, 'shortcut','C').name('Log position');
  */


  f = gui.addFolder('Lights');
  f.addColor(settings.data, 'lightAmbientColor').name('Ambient color').onChange(lightsUpdated);

  f.addColor(settings.data, 'lightPointColor').name('Point color').onChange(lightsUpdated);
  f.add(settings.data, 'lightPointIntensity', 0.001, 10).name('Point intensity').onChange(lightsUpdated);
  f.add(settings.data, 'lightPointDistance', 0, 1000).name('Point distance').onChange(lightsUpdated);
  f.add(settings.data, 'lightPointAngle', 0, Math.PI * 2).name('Point angle').onChange(lightsUpdated);

  f.addColor(settings.data, 'lightDirectionalColor').name('Dir color').onChange(lightsUpdated);
  f.add(settings.data, 'lightDirectionalIntensity', 0.001, 10).name('Dir intensity').onChange(lightsUpdated);
  f.add(settings.data, 'lightDirectionalDistance', 0, 1000).name('Dir distance').onChange(lightsUpdated);
  f.add(settings.data, 'lightDirectionalShadows').name('Dir shadows').onChange(lightsUpdated);


  f = crowd = gui.addFolder('Crowd');

  f = f.addFolder('Defaults');
  f.add(settings.data, 'crowdDefaultSeparationWeight', 1, 200).name('SeparationWeight');
  f.add(settings.data, 'crowdDefaultMaxAcceleration', 1, 100).name('Default MaxAcceleration');
  f.add(settings.data, 'crowdDefaultUpdateFlags', 1, 200).name('Default UpdateFlags');
  f.add(settings.data, 'crowdDefaultMaxSpeed', 1, 100).name('Default MaxSpeed');
  f.add(settings.data, 'crowdDefaultRadius', 1, 20).name('Default Radius');
  f.add(settings.data, 'crowdDefaultHeight', 1, 20).name('Default Height');


  if( initParams.isNetwork ){
    f = gui.addFolder('Networking');
    f.add(settings.data, 'keepAliveInterval').min(16).max(1000).name('Keep Alive Interval (ms)');
    f.add(settings.data, 'sendRate').min(1).max(60).name('Send Rate (hz)');

    f = gui.addFolder('Interpolation');
    f.add(settings.data, 'interpolationMaxFrames').min(0).max(120).name('Max frames (0=none)');
    f.add(settings.data, 'interpolationMaxDistance').min(0).max(1000).name('Max distance diff (px/frame)');
    f.add(settings.data, 'interpolationMinDistance').min(0).max(1000).name('Min distance diff (px/frame)');
  }

  gui.close();

  return gui;
};

var entities = {};

function entityFolderName(entity) {
  return 'Entity: ' + entity.id + ' (' + entity.constructor.name + ')';
}

/**
 * Add an entity's controls to the current GUI
 * @param {Entity} entity The entity to report changes
 */
module.exports.addEntityControls = function( entity ) {

  if (! gui || ! crowd) { return false; }

  var folderName = 'Entity: ' + entity.id + ' (' + entity.constructor.name + ')';
  var f = crowd.addFolder(folderName);

  entities[entity.id] = f;
  
  f.add(entity.state, 'life', 1, 200).name('Life').listen().onChange(entityUpdated);
  f.add(entity.state, 'mana', 1, 200).name('Mana').listen().onChange(entityUpdated);
  f.add(entity.state, 'height', 1, 200).name('Height').listen().onChange(entityUpdated);
  f.add(entity.state, 'radius', 1, 200).name('Radius').listen().onChange(entityUpdated);
  f.add(entity.state, 'maxAcceleration', 1, 200).name('maxAcceleration').listen().onChange(entityUpdated);
  f.add(entity.state, 'maxSpeed', 1, 200).name('maxSpeed').listen().onChange(entityUpdated);

  if (entity.behaviour && entity.behaviour.identifier) {
    // too greedy
    // f.add(entity.behaviour, 'identifier').name('State').listen();
  }

  if (entity.character && entity.character.rotation) {
    f.add(entity.character.rotation, 'y', 0, 2 * Math.PI).name('Rotation Y');
  }

  function entityUpdated() {
    helpersUpdated();
    entity.emit('changed');
    entity._crowd_params_need_update = true;
  }
};

/**
 * Remove an entity's controls from the current GUI
 * @param {Entity} entity The entity to remove
 */
module.exports.removeEntityControls = function( entity ) {

  if (! gui || ! crowd) { return false; }

  try {
    gui.removeFolder(entityFolderName(entity));
  }
  catch (e) {
    console.warn('ERROR: ' + entity.id + ' was already removed from GUI');
  }
};

function helpersUpdated () {
  settings.emit('helpersUpdated');
}

function cameraUpdated() {
  settings.emit('cameraUpdated');
}

function crowdUpdated() {
  settings.emit('crowdUpdated');
}

function fogUpdated() {
  settings.emit('fogUpdated');
}

function lightsUpdated() {
  settings.emit('lightsUpdated');
}

function framerateUpdated(v) {
  settings.data.timestep = 1000/v;
}

function updateQueryStringParameter(uri, key, value) {
  var re = new RegExp('([?|&])' + key + '=.*?(&|$)', 'i');
  var separator = uri.indexOf('?') !== -1 ? '&' : '?';
  if (uri.match(re)) {
    return uri.replace(re, '$1' + key + '=' + value + '$2');
  }
  else {
    return uri + separator + key + '=' + value;
  }
}

exports.shortcut = function(label){
  // keys.trigger(label.toLowerCase());
};

