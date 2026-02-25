import { render } from '@testing-library/react';

import NxUi from './ui';

describe('NxUi', () => {
  it('should render successfully', () => {
    const { baseElement } = render(<NxUi />);
    expect(baseElement).toBeTruthy();
  });
});
