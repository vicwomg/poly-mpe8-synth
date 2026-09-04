#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(CoreMidiPlugin, "CoreMidiPlugin",
    CAP_PLUGIN_METHOD(listInputs, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(scanInputs, CAPPluginReturnPromise);
)
