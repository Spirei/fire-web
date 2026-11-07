const React = require('react');
// Render the actual stateless wrappers in shallow interaction harnesses.
module.exports = function resolveControl(node) {
  while (node && node.props && (['Capsule','IconButton','CapsuleLink'].includes(node.type?.render?.name) || node.type?.name === 'CloseButton')) {
    const key = node.key;
    node = typeof node.type === 'function' ? node.type(node.props) : node.type.render(node.props,node.props.ref);
    if (key != null && React.isValidElement(node)) node = React.cloneElement(node,{key});
  }
  return node;
};
