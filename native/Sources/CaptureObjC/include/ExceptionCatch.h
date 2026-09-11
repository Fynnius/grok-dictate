#pragma once

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Runs `block`. Returns `nil` on success, the exception if one was thrown.
///
/// AVAudioEngine raises `NSException` (not `NSError`) for several illegal
/// states — `prepare()` with no nodes, `removeTap` with no tap. Swift `catch`
/// does not see those, so they abort the process. This is the seam.
NSException *_Nullable GDCatchException(void(NS_NOESCAPE ^block)(void));

NS_ASSUME_NONNULL_END
