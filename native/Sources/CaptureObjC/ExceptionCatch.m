#import "ExceptionCatch.h"

NSException *_Nullable GDCatchException(void(NS_NOESCAPE ^block)(void)) {
    @try {
        block();
        return nil;
    } @catch (NSException *exception) {
        return exception;
    }
}
