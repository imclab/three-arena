'use strict';

var debug = require('debug')('crowd');
var settings = require('./settings');

var _ = require('lodash');

var MIN_DESTINATION_CHANGE = 0.5;
var MIN_SPEED_ANIMATION = 0.5;
var MIN_SPEED_ROTATION = 1.5;

module.exports = Crowd;

/**
 * @exports Crowd
 * 
 * @constructor
 */
function Crowd (game) {

  this.game = game;

  this.agents = {};
  this.agentsCount = 0;

  ///////////////

  // this.MAX_VELOCITY_VECTOR = new THREE.Vector3();

  this._tmp_velocity = new THREE.Vector3(0, 0, 0);

  this._originVector = new THREE.Vector3(0, 0, 0);

  this._boundCheckAgents = this._checkAgents.bind(this);
  this._boundCrowdUpdate = this._updateAgents.bind(this);

  this._route_material = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    opacity: 0.5,
    wireframe: true,
    transparent: true
  });

  var update = this.update.bind(this);
  update.listenerTag = 'crowd system';

  this.game.on('update', update);
}

Crowd.prototype.addAgent = function(entity, options, destination, follow, callback) {

  var self = this;

  entity._crowd_options = crowdOptions(options);

  // add the recast navigation
  self.game.pathfinder.addCrowdAgent(entity._crowd_options, function(idx){

    self.agentsCount++;

    // keep the idx
    idx = parseInt(idx, 0);
    entity._crowd_idx = idx;
    self.agents[''+idx] = entity;

    debug('%o assigned to crowd agent #%d', entity, idx);

    function onEntityDestination(destination) {
      entity._crowd_following = null;
      // dont call the worker for a minor change 
      if (! entity._crowd_destination ||
        destination.position.distanceTo(entity._crowd_destination.position) > MIN_DESTINATION_CHANGE)
      {
        self.game.pathfinder.crowdRequestMoveTarget(idx, destination.position);
        debug('%o walk towards %o', entity, destination);
      }

      // entity.game.destinationMarker.position.copy(destination);
      // entity.game.destinationMarker.animate();

      if (! entity._crowd_current_route || ! entity._crowd_current_route_mesh) {
        entity._crowd_current_route_shape = new THREE.SplineCurve3([ self._originVector, entity.worldToLocal(destination.position.clone()) ]);
        entity._crowd_current_route = new THREE.TubeGeometry(entity._crowd_current_route_shape, entity._crowd_current_route_shape.points.length, 1, 1);
        entity._crowd_current_route_mesh = new THREE.Mesh(entity._crowd_current_route, self._route_material);
        entity.add(entity._crowd_current_route_mesh);
      } else {
        entity._crowd_current_route_shape.points[1].copy(entity.worldToLocal(destination.position.clone()));
        entity._crowd_current_route_shape.needsUpdate = true;
      }

      entity._crowd_destination = destination;
    }

    function onEntityFollow(following) {
      entity._crowd_destination = null;
      // dont call the worker for a minor change 
      if (!entity._crowd_following || entity._crowd_following !== following ||
        following.position.distanceTo(entity._crowd_following.position) > MIN_DESTINATION_CHANGE)
      {
        entity._crowd_following_last_position = following.position.clone();
        self.game.pathfinder.crowdRequestMoveTarget(idx, following.position);
        debug('%o follows %o', entity, following);
      }

      if (! entity._crowd_current_route || ! entity._crowd_current_route_mesh) {
        entity._crowd_current_route_shape = new THREE.SplineCurve3([ self._originVector, entity.worldToLocal(following.position) ]);
        entity._crowd_current_route = new THREE.TubeGeometry(entity._crowd_current_route_shape, entity._crowd_current_route_shape.points.length, 1, 1);
        entity._crowd_current_route_mesh = new THREE.Mesh(entity._crowd_current_route, self._route_material);
        entity.add(entity._crowd_current_route_mesh);
      } else {
        entity._crowd_current_route_shape.points[1].copy(entity.worldToLocal(following.position));
        entity._crowd_current_route_shape.needsUpdate = true;
      }

      entity._crowd_following = following;
    }

    function onEntityUnfollow() {
      entity._crowd_destination = null;
      entity._crowd_following = null;
    }

    function onEntityDeath() {
      self.removeAgent(entity);
      entity._crowd_idx = null;

      entity.removeListener('death', onEntityDeath);
      entity.removeListener('follow', onEntityFollow);
      entity.removeListener('destination', onEntityDestination);
      entity.removeListener('nodestination', onEntityUnfollow);
      entity.removeListener('unfollow', onEntityUnfollow);
    }

    entity._crowd_removeAllListeners = function() {
      entity.removeListener('death', onEntityDeath);
      entity.removeListener('follow', onEntityFollow);
      entity.removeListener('destination', onEntityDestination);
      entity.removeListener('nodestination', onEntityUnfollow);
      entity.removeListener('unfollow', onEntityUnfollow);
    };

    // listen on entity events
    entity.on('death', onEntityDeath);
    entity.on('follow', onEntityFollow);
    entity.on('destination', onEntityDestination);
    entity.on('nodestination', onEntityUnfollow);
    entity.on('unfollow', onEntityUnfollow);

    if (typeof callback === 'function') {
      callback(entity);
    }

    if (destination) {
      entity.emit('destination', destination);
    }

    if (follow) {
      entity.emit('follow', follow);
    }

  });
};

Crowd.prototype.removeAgent = function(entity) {

  if (typeof entity._crowd_idx === 'undefined') {
    throw 'This entity is not in the crowd';
  }

  this.game.pathfinder.removeCrowdAgent(entity._crowd_idx);
  this.agentsCount--;
};

Crowd.prototype.requestMoveVelocity = function(entity, velocity) {

  if (typeof entity._crowd_idx === 'undefined') {
    throw 'This entity is not in the crowd';
  }

  this.game.pathfinder.requestMoveVelocity(entity._crowd_idx, velocity);
};

/**
 * Instantly teleport an entity to a new position
 * @param  {Entity}   entity      Entity to teleport
 * @param  {Vector3}  newPosition The desired new position
 * @param  {Function=} callback   Optional callback(error, newPosition)
 * @return {Entity}               The entity to be teleported
 */
Crowd.prototype.teleport = function(entity, newPosition, callback) {

  var self = this;

  if (typeof entity._crowd_idx === 'undefined') {
    throw 'This entity is not in the crowd';
  }

  entity.game.pathfinder.findNearest(newPosition, function(nearestPosition){

    entity._crowd_removeAllListeners();

    var options = entity._crowd_options;
    options.position = nearestPosition;

    var following = entity._crowd_following;
    var destination = entity._crowd_destination;

    self.removeAgent(entity);
    self.addAgent(entity, options, destination, following, callback);
  });
};

Crowd.prototype.update = function() {

  var self = this;

  if (self.agentsCount > 0) {

    // update routes visibility
    this._route_material.visible = settings.data.visibleCharactersRoutes;

    // check all agents state
    _.forEach(self.agents, this._boundCheckAgents);

    // update the crowd
    self.game.pathfinder.crowdUpdate(this.game.delta * 2 /* FIXME: why ? */, this._boundCrowdUpdate);
  }
};

Crowd.prototype._checkAgents = function(entity, idx) {

  idx = parseInt(idx, 0);

  // update dirty params
  if (entity._crowd_params_need_update) {
    debug('update crowd params for %o', entity);
    entity._crowd_params_need_update = false;
    
    // this.game.pathfinder.updateCrowdAgentParameters(idx, crowdOptions(entity.state));
    var oldFoll = entity._crowd_following;
    var oldDest = entity._crowd_destination;

    this.removeAgent(entity);
    this.addAgent(entity, entity.state, oldDest, oldFoll);
  }

  // update dirty follow
  // TODO: also use a _dirtyMove flag ?
  if (entity._crowd_following) {
    // dont call the worker for a minor change 
    if (entity._crowd_following_last_position.distanceTo(entity._crowd_following.position) > 2.0 * MIN_DESTINATION_CHANGE)
    {
      this.game.pathfinder.crowdRequestMoveTarget(idx, entity._crowd_following.position);
      entity._crowd_following_last_position.copy(entity._crowd_following.position);
    }
  }
};

Crowd.prototype._updateAgents = function(agents){

  for (var i = 0; i < agents.length; i++) {

    var agent = agents[i];
    var idx = agent.idx;
    var entity = this.agents[idx];

    if (entity._crowd_idx && (! agent.active || entity.isDead())) {
      this.removeAgent(entity);
      continue;
    }

    if (entity.state.isStatic) {
      // continue;
    }

    var destination = entity._crowd_destination || entity._crowd_following;

    // check if agent is arrived
    // could be done in recastnavigation, but not all entities are agents :/
    if (destination && destination.state && destination.state.radius > 0) {
      if (destination.position.distanceTo(entity.position) - destination.state.radius - entity.state.radius <= 0) {
        // continue;
        agent.velocity.x = agent.velocity.y = agent.velocity.z = 0.0;
        agent.position = entity.position;
      }
    }

    // update routes
    /*
    if (destination && entity._crowd_current_route) {
      entity._crowd_current_route_shape.points[1].copy(entity.worldToLocal(destination.position.clone()));
      entity._crowd_current_route_shape.updateArcLengths();
      entity._crowd_current_route_mesh.geometry.verticesNeedUpdate = true;
      entity._crowd_current_route_shape.needsUpdate = true;

      var geometry = entity._crowd_current_route_mesh.geometry;
      geometry.verticesNeedUpdate = true;
      geometry.morphTargetsNeedUpdate = true;
      geometry.elementsNeedUpdate = true;
      geometry.uvsNeedUpdate = true;
      geometry.normalsNeedUpdate = true;
      geometry.tangentsNeedUpdate = true;
      geometry.colorsNeedUpdate = true;
    }
    */

    this._tmp_velocity.set(agent.velocity.x, 0, agent.velocity.z);

    var speed = this._tmp_velocity.length();

    entity.isMoving = speed > 0;

    // update back entity position & rotation
    entity.position.copy(agent.position);

    if (speed > MIN_SPEED_ANIMATION) {

      if (entity.character) {
        entity.character.controls.moveForward = true;
        entity.character.setAnimation('run');
      }

    } else {

      if (entity.character) {
        entity.character.controls.moveForward = false;
        entity.character.setAnimation('stand');
      }
    }

    if (speed > MIN_SPEED_ROTATION) {
      var angle = Math.atan2(- this._tmp_velocity.z, this._tmp_velocity.x);
      entity.rotation.y = angle;
    }
  }
};

function crowdOptions(options) {
  return options = _.merge({
    position: { x:0, y:0, z:0 },
    separationWeight: settings.data.crowdDefaultSeparationWeight,
    maxAcceleration: settings.data.crowdDefaultMaxAcceleration,
    updateFlags: settings.data.crowdDefaultUpdateFlags,
    maxSpeed: settings.data.crowdDefaultMaxSpeed,
    radius: settings.data.crowdDefaultRadius,
    height: settings.data.crowdDefaultHeight
  }, {
    position: options.position,
    separationWeight: options.separationWeight,
    maxAcceleration: options.maxAcceleration,
    updateFlags: options.updateFlags,
    maxSpeed: options.maxSpeed,
    radius: options.radius,
    height: options.height
  });
}
